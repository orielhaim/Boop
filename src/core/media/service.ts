import type { UploadProgress } from "./blossom";
import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import type { MessagingRepository } from "@/db/messaging";
import type { MediaSdk } from "./index";
import { removeMediaFile as remove } from "./files";
import { hashAttachmentFile, openAttachment, sealAttachment } from "./crypto";
import { createManualDownloads } from "./manual-download";
import { usesBackgroundUpload } from "./attachment-transfers";
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
  let retired = false;
  let generation = 0;
  const listeners = new Set<{ id?: string; run: () => void }>();
  const uploading = new Map<string, UploadProgress>();
  const downloadStates = new Map<string, DownloadState>();
  const uploads = new Map<
    string,
    { peer: string; abort: AbortController; background: boolean }
  >();
  const plaintext = new Map<
    string,
    { file: Directory; peer: string; hash: string; release: () => void }
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
      if (Paths.availableDiskSpace < limit) throw new Error("media-storage");
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
              file.size,
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
        if (file.size !== undefined && length !== file.size)
          throw new Error("media-integrity");
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
      item.release();
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
    setActive(next: boolean, background = false) {
      if (retired) return;
      if (!next) {
        downloads.cancelAll();
        for (const upload of uploads.values())
          if (!background || !upload.background) upload.abort.abort();
      }
      if (next === active) return;
      active = next;
      generation++;
      if (!next) {
        forgetPlaintext();
      } else {
        sdk.transfers.reconcile((row) => {
          if (isBlocked(row.peer)) return false;
          const entry = chat.attachment(row.peer, row.messageId);
          return !!entry && !entry.url && entry.file.hash === row.hash;
        });
      }
      notify();
    },
    block(peer: string) {
      sdk.transfers.revoke((row) => row.peer === peer);
      for (const upload of uploads.values())
        if (upload.peer === peer) upload.abort.abort();
      downloads.cancelAll(peer);
      forgetPlaintext(peer);
      notify();
    },
    retire() {
      active = false;
      retired = true;
      generation++;
      downloads.cancelAll();
      for (const { abort } of uploads.values()) abort.abort();
      sdk.transfers.revoke(() => true);
      forgetPlaintext();
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
        work.create({ idempotent: true, intermediates: true });
        const token = randomUUID();
        const lease = new Directory(work, token);
        lease.create();
        const output = new File(lease, localAttachmentName(entry.file));
        const release = cache.retain(entry.file.hash, entry.source);
        try {
          await openAttachment(entry.encrypted, output, entry.file, signal);
          if (signal.aborted || session !== generation || !find(peer, id))
            throw new Error("media-cancelled");
          cache.touch(entry.file.hash, entry.source);
          plaintext.set(token, {
            file: lease,
            peer,
            hash: entry.file.hash,
            release,
          });
          return {
            uri: output.uri,
            dispose() {
              remove(lease);
              release();
              plaintext.delete(token);
            },
          };
        } catch (error) {
          remove(lease);
          release();
          if (
            session === generation &&
            !signal.aborted &&
            entry.source === "download" &&
            error instanceof Error &&
            ["media-integrity", "media-format"].includes(error.message)
          ) {
            cache.remove(entry.file.hash, "download");
            downloadStates.set(id, "media-integrity");
            notify();
          }
          throw error;
        }
      });
    },
    async stageAttachment(
      uri: string,
      metadata: AttachmentMetadata,
      save: (file: Awaited<ReturnType<typeof sealAttachment>>) => void,
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
        await prepare(async () => {
          if (!active || session !== generation)
            throw new Error("media-cancelled");
          work.create({ idempotent: true, intermediates: true });
          const temp = new File(work, `${randomUUID()}.bin`);
          try {
            const file = await sealAttachment(source, temp, checked);
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
        });
      } finally {
        if (metadata.kind === "voice" && uri.startsWith("file:///"))
          remove(source);
      }
    },
    async upload(peer: string, id: string, valid: () => boolean) {
      const entry = find(peer, id);
      if (entry?.source !== "sent") throw new Error("media-unavailable");
      const abort = new AbortController();
      const background =
        entry.file.kind !== "voice" &&
        usesBackgroundUpload(entry.encrypted.size);
      uploads.set(id, { peer, abort, background });
      const release = cache.retain(entry.file.hash, "sent");
      let mirroring = false;
      const progress = (phase: UploadProgress) => {
        if (uploading.get(id) === phase) return;
        uploading.set(id, phase);
        notify(id);
      };
      try {
        const context = { id, peer };
        const size = entry.encrypted.size;
        const recovered = await sdk.transfers.recover(
          context,
          entry.encrypted.uri,
          entry.file.hash,
          size,
          abort.signal,
          progress,
        );
        if (recovered) return recovered;
        if (!valid() || abort.signal.aborted)
          throw new Error("media-cancelled");
        if (
          (await hashAttachmentFile(entry.encrypted, abort.signal)) !==
          entry.file.hash
        )
          throw new Error("media-integrity");
        const result = await sdk.upload(
          "attachment",
          {
            uri: entry.encrypted.uri,
            size,
            hash: entry.file.hash,
            context: background ? context : undefined,
          },
          {
            signal: abort.signal,
            expectedHash: entry.file.hash,
            progress,
            canStart: valid,
          },
        );
        if (result.mirror) {
          mirroring = true;
          void result.mirror.finally(() => {
            release();
            uploads.delete(id);
            uploading.delete(id);
            notify(id);
          });
        }
        return result.url;
      } finally {
        if (!mirroring) {
          release();
          uploads.delete(id);
          uploading.delete(id);
          notify(id);
        }
      }
    },
    finishUpload(id: string) {
      sdk.transfers.forget(id);
    },
    canPauseUpload(id: string) {
      return uploads.get(id)?.background === true;
    },
    pauseUpload(id: string) {
      uploads.get(id)?.abort.abort();
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
