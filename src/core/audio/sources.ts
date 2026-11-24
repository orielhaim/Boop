import { acceptedAttachments } from "@/core/marmot/message-projection";
import { randomUUID } from "expo-crypto";
import { getDocumentAsync } from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import type { AudioHandle } from "./controller";
import { audioFile, type Track } from "./types";
import type { DownloadManager } from "@/core/downloads/manager";
import type { DownloadFile } from "@/core/downloads/transport";
import { waitForDownload } from "./download";
import { waitForAudioAuthority } from "./authorization";
import { sourceId } from "@/core/downloads/types";
import { marmot } from "@/core/marmot/native";
import {
  localMediaUri,
  openLocalAttachment,
} from "@/core/media/open-local-attachment";

type AcquireOptions = {
  signal: AbortSignal;
  download: boolean;
  invalidate(): void;
};

export function createAudioSources({
  scope,
  downloads,
  ready,
  allowed,
  canDownload,
  canImport,
  blocked,
  subscribePrivacy,
}: {
  scope: string;
  downloads: DownloadManager;
  ready(): boolean;
  allowed(track: Track): boolean;
  canDownload(): boolean;
  canImport(): boolean;
  blocked(sender: string): boolean;
  subscribePrivacy(listener: () => void): () => void;
}) {
  const directory = new Directory(Paths.document, "audio", scope);
  const deviceFile = (track: Extract<Track, { kind: "device" }>) => {
    if (!/^[a-f0-9-]{36}(\.[a-z0-9]{1,12})?$/u.test(track.file))
      throw new Error("InvalidMediaPath");
    return new File(directory, track.file);
  };

  async function acquire(
    track: Track,
    options: AcquireOptions,
  ): Promise<AudioHandle & { file: DownloadFile }> {
    const check = () => {
      if (options.signal.aborted || !allowed(track))
        throw new Error("AudioUnavailable");
    };
    check();
    let closeWindow: (() => Promise<void>) | undefined;
    let unsubscribe: (() => void) | undefined;
    let releaseFile: (() => Promise<void>) | undefined;
    let file: DownloadFile;
    async function release() {
      unsubscribe?.();
      const close = closeWindow;
      const dispose = releaseFile;
      closeWindow = undefined;
      releaseFile = undefined;
      await Promise.allSettled([close?.(), dispose?.()]);
    }
    try {
      if (track.kind === "device") {
        const local = deviceFile(track);
        if (!local.exists) throw new Error("AudioUnavailable");
        file = {
          path: decodeURIComponent(local.uri.slice(7)),
          name: track.title,
          type: track.type,
        };
      } else {
        const { source } = track;
        const id = sourceId(source);
        const download = async () => {
          check();
          if (!options.download || !canDownload())
            throw new Error("AudioUnavailable");
          if (downloads.get(id)?.state === "completed") {
            await downloads.reconcile();
            check();
          }
          if (downloads.get(id)?.state === "paused") downloads.resume(id);
          else downloads.enqueue(source);
          await waitForDownload(downloads, source, options.signal);
          check();
        };
        let stopWatchingWindow: (() => void) | undefined;
        if (source.kind === "marmot") {
          const [group, message, event, index] = source.target;
          if (!ready()) throw new Error("AudioUnavailable");
          check();
          const window = await marmot.openConversation(group, {
            target: message,
          });
          closeWindow = async () => {
            stopWatchingWindow?.();
            await window.close();
          };
          const authorized = () => {
            const state = window.getState();
            if (state.status !== "ready" || !ready() || !allowed(track))
              return false;
            const { snapshot } = state;
            return (
              snapshot.authorityReady &&
              !snapshot.invited &&
              snapshot.canSend &&
              !(snapshot.peer && blocked(snapshot.peer)) &&
              snapshot.messages.some(
                (row) =>
                  row.id === message &&
                  row.sourceId === event &&
                  row.sender === source.sender &&
                  !row.deleted &&
                  !row.invalidationStatus &&
                  (row.expiresAt == null ||
                    row.expiresAt * 1000 > Date.now()) &&
                  acceptedAttachments(row).some(
                    (attachment) => attachment.index === index,
                  ),
              )
            );
          };
          await waitForAudioAuthority(window, options.signal);
          check();
          if (!authorized()) throw new Error("AudioUnavailable");
          const validate = () => {
            if (!authorized()) options.invalidate();
          };
          const stopWindow = window.subscribe(validate);
          const stopPrivacy = subscribePrivacy(validate);
          stopWatchingWindow = () => {
            stopWindow();
            stopPrivacy();
          };
          if ((await marmot.retainedAttachmentBytes(...source.target)) === null)
            await download();
          check();
          if (!authorized()) throw new Error("AudioUnavailable");
          const lease = await marmot.openAttachment(...source.target);
          if (!lease) throw new Error("AudioUnavailable");
          releaseFile = () => marmot.releaseAttachment(lease.lease);
          if (!authorized()) throw new Error("AudioUnavailable");
          file = lease;
        } else {
          if (downloads.get(id)?.state !== "completed") await download();
          let local: DownloadFile | undefined;
          await downloads.open(id, async (value) => {
            local = value;
          });
          if (!local) throw new Error("AudioUnavailable");
          file = local;
        }
        let managed = downloads.get(id)?.state === "completed";
        unsubscribe = downloads.subscribe(() => {
          const job = downloads.get(id);
          if (job?.state === "completed") managed = true;
          if (
            managed &&
            (job?.state !== "completed" || job.intent === "remove")
          )
            options.invalidate();
        });
      }
      check();
      const metadata = track.voice
        ? undefined
        : await marmot.audioMetadata(file.path).catch(() => undefined);
      check();
      return { file, uri: localMediaUri(file.path), metadata, release };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async function importFile(
    imported: File,
    name: string,
    type: string,
  ): Promise<Track> {
    if (!canImport() || !audioFile(name, type))
      throw new Error("AudioUnavailable");
    const size = imported.size;
    if (!size || size > 1024 ** 3 || size > Paths.availableDiskSpace)
      throw new Error("AudioStorageUnavailable");
    const extension = /\.[a-z0-9]{1,12}$/iu.exec(name)?.[0].toLowerCase() ?? "";
    const track: Track = {
      kind: "device",
      file: randomUUID() + extension,
      title: name,
      type,
      voice: false,
    };
    directory.create({ intermediates: true, idempotent: true });
    const destination = deviceFile(track);
    try {
      await imported.copy(destination);
      if (!canImport() || destination.size !== size)
        throw new Error("AudioUnavailable");
      const metadata = await marmot
        .inspectMediaFile(
          decodeURIComponent(destination.uri.slice(7)),
          false,
          false,
        )
        .catch(() => undefined);
      if (!canImport()) throw new Error("AudioUnavailable");
      return { ...track, duration: metadata?.duration ?? undefined };
    } catch (error) {
      if (destination.exists) destination.delete();
      throw error;
    }
  }

  return {
    acquire,
    async external(track: Track, signal: AbortSignal, download: boolean) {
      const invalid = new AbortController();
      const abort = () => invalid.abort();
      if (signal.aborted) return;
      signal.addEventListener("abort", abort, { once: true });
      let source: Awaited<ReturnType<typeof acquire>> | undefined;
      try {
        source = await acquire(track, {
          signal: invalid.signal,
          download,
          invalidate: abort,
        });
        if (!invalid.signal.aborted && allowed(track))
          await openLocalAttachment(source.file, true);
      } finally {
        signal.removeEventListener("abort", abort);
        await source?.release();
      }
    },
    importContent(uri: string) {
      if (!/^content:\/\/[^/?#]+\/.+/iu.test(uri) || uri.length > 4096)
        throw new Error("AudioUnavailable");
      const file = new File(uri);
      return importFile(file, file.name, file.type);
    },
    async pick(): Promise<Track | undefined> {
      const result = await getDocumentAsync({
        type: ["audio/*", "application/ogg"],
        copyToCacheDirectory: true,
      });
      const asset = result.assets?.[0];
      if (!asset) return;
      const imported = new File(asset.uri);
      try {
        return await importFile(
          imported,
          asset.name,
          asset.mimeType ?? "application/octet-stream",
        );
      } finally {
        if (imported.uri.startsWith(Paths.cache.uri) && imported.exists)
          imported.delete();
      }
    },
  };
}
