import { randomUUID } from "expo-crypto";
import { getDocumentAsync } from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { audioFile, type Track } from "./types";
import { createMediaSources, type AcquireOptions } from "@/core/media/sources";
import { marmot } from "@/core/marmot/native";
import { openLocalAttachment } from "@/core/media/open-local-attachment";

export function createAudioSources(
  sources: ReturnType<typeof createMediaSources<Track>>,
  canImport: () => boolean,
  allowed: (track: Track) => boolean,
) {
  const { directory, deviceFile } = sources;

  async function acquire(
    track: Track,
    options: Omit<AcquireOptions, "progressive">,
  ) {
    const handle = await sources.acquire(track, options);
    const metadata = track.voice
      ? undefined
      : await marmot.audioMetadata(handle.file.path).catch(() => undefined);
    if (options.signal.aborted || !allowed(track)) {
      await handle.release();
      throw new Error("AudioUnavailable");
    }
    return { ...handle, metadata };
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
          await openLocalAttachment(source.file, true, invalid.signal);
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
