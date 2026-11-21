import type { UploadProgress } from "./blossom";
import { randomUUID } from "expo-crypto";
import { Directory, File } from "expo-file-system";
import type { MessagingRepository } from "@/db/messaging";
import type { MediaSdk } from "./index";
import { removeMediaFile as remove } from "./files";
import { openAttachment, sealAttachment } from "./crypto";
import { createManualDownloads } from "./manual-download";
import {
  byteLimit,
  minVoiceDuration,
  attachmentMetadata,
  type AttachmentMetadata,
  localAttachmentName,
} from "./protocol";

type Source = "sent" | "download";
type DownloadState =
  | "not-downloaded"
  | "downloading"
  | "verifying"
  | "downloaded"
  | "failed"
  | "missing"
  | "media-integrity"
  | "media-format"
  | "media-storage"
  | "cancelled"
  | number;

export type AttachmentMedia = ReturnType<typeof createAttachmentMedia>;

export function createAttachmentMedia(
  chat: MessagingRepository,
  isBlocked: (peer: string) => boolean,
  sdk: MediaSdk,
) {
  const cache = sdk.blobCache;
  const { work } = cache;
  let active = false;
  let generation = 0;
  const listeners = new Set<{ id?: string; run: () => void }>();
  const uploading = new Map<string, UploadProgress>();
  const downloadStates = new Map<string, DownloadState>();
  const uploads = new Map<string, { peer: string; abort: AbortController }>();
  const plaintext = new Map<
    string,
    { file: Directory; peer: string; hash: string }
  >();
  let preparation = Promise.resolve();
  function prepare<T>(job: () => Promise<T>) {
    const next = preparation.then(job);
    preparation = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  function authorize(peer: string, id: string) {
    const record =
      active && !isBlocked(peer) ? chat.attachment(peer, id) : undefined;
    if (record?.url) return { ...record.file, url: record.url };
  }
  const downloads = createManualDownloads({
    authorize,
    async transfer(file, signal, limit, peer, id) {
      const valid = () =>
        !signal.aborted && authorize(peer, id)?.hash === file.hash;
      if (!valid()) throw new Error("media-cancelled");
      work.create({ idempotent: true, intermediates: true });
      const tempId = randomUUID();
      const temp = new File(work, `${tempId}.bin`);
      try {
        const candidates = [file.url, ...(file.fallbacks ?? [])];
        let length = 0;
        for (const [index, url] of candidates.entries()) {
          try {
            length = await sdk.downloadExplicit(
              index === 0 ? tempId : randomUUID(),
              url,
              temp.uri,
              file.hash,
              limit,
              signal,
              (progress) => {
                if (signal.aborted || downloadStates.get(id) === progress)
                  return;
                downloadStates.set(id, progress);
                notify(id);
              },
            );
            break;
          } catch (error) {
            if (
              !valid() ||
              index === candidates.length - 1 ||
              !(error instanceof Error) ||
              error.message !== "missing"
            )
              throw error;
            remove(temp);
          }
        }
        if (!valid()) throw new Error("media-cancelled");
        if (length !== temp.size || length > limit || length < 17)
          throw new Error("media-integrity");
        downloadStates.set(id, "verifying");
        notify(id);
        await prepare(async () => {
          if (!valid()) throw new Error("media-cancelled");
          const clear = await openAttachment(await temp.bytes(), file);
          clear.fill(0);
        });
        if (!valid()) throw new Error("media-cancelled");
        try {
          cache.promote(temp, file.hash, "download");
          notify();
        } catch {
          throw new Error("media-storage");
        }
      } finally {
        remove(temp);
      }
    },
  });

  function notify(id?: string) {
    for (const listener of listeners)
      if (!id || !listener.id || listener.id === id) listener.run();
  }

  function find(peer: string, id: string) {
    const attachment =
      active && !isBlocked(peer) ? chat.attachment(peer, id) : undefined;
    if (!attachment) return;
    const { hash } = attachment.file;
    const source: Source = cache.get(hash, "sent") ? "sent" : "download";
    const file = cache.get(hash, source);
    if (file) return { ...attachment, encrypted: file, source };
  }

  function forgetPlaintext(peer?: string, hash?: string) {
    for (const [key, item] of plaintext) {
      if ((peer && peer !== item.peer) || (hash && hash !== item.hash))
        continue;
      remove(item.file);
      plaintext.delete(key);
    }
  }

  cache.sweep((hash) => chat.hasAttachment(hash));

  return {
    subscribe(run: () => void, id?: string) {
      const listener = { run, id };
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    uploadProgress: (id: string) => uploading.get(id),
    setActive(next: boolean) {
      if (next === active) return;
      active = next;
      generation++;
      if (!next) {
        downloads.cancelAll();
        for (const { abort } of uploads.values()) abort.abort();
        forgetPlaintext();
      }
      notify();
    },
    block(peer: string) {
      for (const upload of uploads.values())
        if (upload.peer === peer) upload.abort.abort();
      downloads.cancelAll(peer);
      forgetPlaintext(peer);
      notify();
    },
    cancel(peer: string, id: string) {
      downloadStates.set(id, "cancelled");
      downloads.cancel(peer, id);
      notify(id);
    },
    downloadState(peer: string, id: string) {
      if (find(peer, id)) return "downloaded";
      return downloadStates.get(id) ?? "not-downloaded";
    },
    async download(peer: string, id: string) {
      const state = downloadStates.get(id);
      if (
        find(peer, id) ||
        state === "downloading" ||
        state === "verifying" ||
        typeof state === "number"
      )
        return;
      downloadStates.set(id, "downloading");
      notify(id);
      try {
        await downloads.download(peer, id);
        downloadStates.delete(id);
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        const failure =
          code === "media-integrity" ||
          code === "media-format" ||
          code === "media-storage" ||
          code === "missing"
            ? code
            : "failed";
        if (active && chat.attachment(peer, id) && !isBlocked(peer)) {
          if (downloadStates.get(id) !== "cancelled" && downloadStates.has(id))
            downloadStates.set(id, failure);
        } else downloadStates.delete(id);
      } finally {
        if (downloadStates.size > 256) {
          const failed = [...downloadStates].find(
            ([, state]) =>
              state !== "downloading" &&
              state !== "verifying" &&
              typeof state !== "number",
          );
          if (failed) downloadStates.delete(failed[0]);
        }
        notify();
      }
    },
    preparePlayback(peer: string, id: string, signal: AbortSignal) {
      const session = generation;
      return prepare(async () => {
        if (signal.aborted || session !== generation)
          throw new Error("media-cancelled");
        const entry = find(peer, id);
        if (!entry) throw new Error("media-unavailable");
        let audio: Awaited<ReturnType<typeof openAttachment>>;
        try {
          audio = await openAttachment(
            await entry.encrypted.bytes(),
            entry.file,
          );
        } catch (error) {
          if (
            session === generation &&
            !signal.aborted &&
            entry.source === "download"
          ) {
            cache.remove(entry.file.hash, "download");
            downloadStates.set(id, "media-integrity");
            notify();
          }
          throw error;
        }
        try {
          if (signal.aborted || session !== generation || !find(peer, id))
            throw new Error("media-cancelled");
          work.create({ idempotent: true, intermediates: true });
          const token = randomUUID();
          const lease = new Directory(work, token);
          lease.create();
          const output = new File(lease, localAttachmentName(entry.file));
          try {
            await output.write(audio);
            if (signal.aborted || session !== generation || !find(peer, id))
              throw new Error("media-cancelled");
            cache.touch(entry.file.hash, entry.source);
            plaintext.set(token, { file: lease, peer, hash: entry.file.hash });
            return {
              uri: output.uri,
              dispose() {
                remove(lease);
                plaintext.delete(token);
              },
            };
          } catch (error) {
            remove(lease);
            throw error;
          }
        } finally {
          audio.fill(0);
        }
      });
    },
    async stageAttachment(
      uri: string,
      metadata: AttachmentMetadata,
      save: (file: Awaited<ReturnType<typeof sealAttachment>>["file"]) => void,
    ) {
      const source = new File(uri);
      const session = generation;
      try {
        const checked = attachmentMetadata.parse(metadata);
        if (
          !active ||
          !uri.startsWith("file:///") ||
          !source.exists ||
          !source.size ||
          (checked.kind === "voice" &&
            (checked.durationMs ?? 0) < minVoiceDuration)
        )
          throw new Error("media-format");
        if (source.size > byteLimit(checked.kind) - 16)
          throw new Error("media-size");
        const audio = await source.bytes();
        try {
          const { file, bytes } = await sealAttachment(audio, checked);
          if (!active || session !== generation)
            throw new Error("media-cancelled");
          work.create({ idempotent: true, intermediates: true });
          const temp = new File(work, `${randomUUID()}.bin`);
          try {
            await temp.write(bytes);
            if (!active || session !== generation)
              throw new Error("media-cancelled");
            cache.promote(temp, file.hash, "sent", (hash) =>
              chat.hasAttachment(hash, true),
            );
            try {
              save(file);
              notify();
            } catch (error) {
              cache.remove(file.hash, "sent");
              throw error;
            }
          } finally {
            remove(temp);
          }
        } finally {
          audio.fill(0);
        }
      } finally {
        if (metadata.kind === "voice" && uri.startsWith("file:///"))
          remove(source);
      }
    },
    async upload(peer: string, id: string, valid: () => boolean) {
      const entry = find(peer, id);
      if (entry?.source !== "sent") throw new Error("media-unavailable");
      const abort = new AbortController();
      uploads.set(id, { peer, abort });
      let mirroring = false;
      try {
        const bytes = await entry.encrypted.bytes();
        if (!valid() || abort.signal.aborted)
          throw new Error("media-cancelled");
        const result = await sdk.upload("attachment", bytes, {
          signal: abort.signal,
          expectedHash: entry.file.hash,
          progress(phase) {
            uploading.set(id, phase);
            notify(id);
          },
        });
        if (result.mirror) {
          mirroring = true;
          void result.mirror.finally(() => {
            uploads.delete(id);
            uploading.delete(id);
            notify(id);
          });
        }
        return result.url;
      } finally {
        if (!mirroring) {
          uploads.delete(id);
          uploading.delete(id);
          notify(id);
        }
      }
    },
    cancelUpload(id: string, hash: string) {
      uploads.get(id)?.abort.abort();
      if (!chat.hasAttachment(hash)) cache.remove(hash, "sent");
      notify();
    },
    canRemoveDownload(peer: string, id: string) {
      return find(peer, id)?.source === "download";
    },
    removeDownload(peer: string, id: string) {
      const entry = find(peer, id);
      if (entry?.source !== "download") return;
      cache.remove(entry.file.hash, "download");
      forgetPlaintext(peer, entry.file.hash);
      notify();
    },
    usage: () => cache.usage("download"),
    clearDownloads() {
      generation++;
      downloads.cancelAll();
      forgetPlaintext();
      downloadStates.clear();
      cache.clear("download");
      notify();
    },
  };
}
