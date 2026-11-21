import type { UploadProgress } from "./blossom";
import { randomUUID } from "expo-crypto";
import { File } from "expo-file-system";
import type { MessagingRepository } from "@/db/messaging";
import type { MediaSdk } from "./index";
import { removeMediaFile as remove } from "./files";
import { openVoice, sealVoice } from "./crypto";
import { createManualDownloads } from "./manual-download";
import {
  maxAttachmentBytes,
  minVoiceDuration,
  voiceMetadata,
  type VoiceMetadata,
} from "./protocol";

type Source = "sent" | "download";
type DownloadState =
  | "not-downloaded"
  | "downloading"
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
  const plaintext = new Map<string, { file: File; peer: string }>();
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
        const length = await sdk.downloadExplicit(
          tempId,
          file.url,
          temp.uri,
          file.hash,
          limit,
          signal,
          (progress) => {
            if (signal.aborted || downloadStates.get(id) === progress) return;
            downloadStates.set(id, progress);
            notify(id);
          },
        );
        if (!valid()) throw new Error("media-cancelled");
        if (length !== temp.size || length > limit || length < 17)
          throw new Error("media-integrity");
        const audio = await openVoice(await temp.bytes(), file);
        audio.fill(0);
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

  function forgetPlaintext(peer?: string) {
    for (const [key, item] of plaintext) {
      if (peer && peer !== item.peer) continue;
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
            ([, state]) => state !== "downloading" && typeof state !== "number",
          );
          if (failed) downloadStates.delete(failed[0]);
        }
        notify();
      }
    },
    async preparePlayback(peer: string, id: string, signal: AbortSignal) {
      const entry = find(peer, id);
      if (!entry) throw new Error("media-unavailable");
      const session = generation;
      const audio = await openVoice(await entry.encrypted.bytes(), entry.file);
      try {
        if (signal.aborted || session !== generation || !find(peer, id))
          throw new Error("media-cancelled");
        work.create({ idempotent: true, intermediates: true });
        const token = randomUUID();
        const output = new File(work, `${token}.m4a`);
        try {
          await output.write(audio);
          if (signal.aborted || session !== generation || !find(peer, id))
            throw new Error("media-cancelled");
          cache.touch(entry.file.hash, entry.source);
          plaintext.set(token, { file: output, peer });
          return {
            uri: output.uri,
            dispose() {
              remove(output);
              plaintext.delete(token);
            },
          };
        } catch (error) {
          remove(output);
          throw error;
        }
      } finally {
        audio.fill(0);
      }
    },
    async stageRecording(
      uri: string,
      metadata: VoiceMetadata,
      save: (file: Awaited<ReturnType<typeof sealVoice>>["file"]) => void,
    ) {
      const source = new File(uri);
      const session = generation;
      try {
        const checked = voiceMetadata.parse(metadata);
        if (
          !active ||
          !source.exists ||
          source.size > maxAttachmentBytes - 16 ||
          (checked.durationMs ?? 0) < minVoiceDuration
        )
          throw new Error("media-format");
        const audio = await source.bytes();
        try {
          const { file, bytes } = await sealVoice(audio, checked);
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
