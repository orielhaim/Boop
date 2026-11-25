import { randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { marmot } from "@/core/marmot/native";
import { torrentsSource } from "@/core/downloads/types";
import { localMediaUri } from "@/core/media/open-local-attachment";
import { initializeLocal } from "@/services/local";
import type { AppLock } from "@/core/security/app-lock";
import { videoImportDirectory } from "./import-cache";
import { videoFile } from "./types";
import type { SubtitleInput } from "./subtitles/tracks";
import { relatedSubtitle } from "./subtitles/tracks";
import { readSelectedSubtitles } from "./subtitle-files";

let importing = false;

function isScopedVideoUri(uri: string) {
  if (uri.length > 4096) return false;
  if (uri.startsWith("content://")) {
    return (
      /^content:\/\/[a-z0-9_.-]+\/.+/iu.test(uri) &&
      !/^content:\/\/com\.orielhaim\.boop(?:[./]|$)/iu.test(uri)
    );
  }
  const cache = Paths.cache.uri.replace(/\/$/u, "") + "/";
  if (!uri.startsWith(cache)) return false;
  try {
    return uri
      .slice(cache.length)
      .split("/")
      .every((part) => {
        const segment = decodeURIComponent(part);
        return (
          segment !== "." && segment !== ".." && !/[/\\\x00]/u.test(segment)
        );
      });
  } catch {
    return false;
  }
}

function waitForActive(lock: AppLock) {
  const state = lock.getState();
  if (state.active || state.locked) return Promise.resolve(!state.locked);
  return new Promise<boolean>((resolve) => {
    function finish(allowed: boolean) {
      unsubscribe();
      clearTimeout(timeout);
      resolve(allowed);
    }
    const timeout = setTimeout(() => finish(false), 1_500);
    const unsubscribe = lock.subscribe((state) => {
      if (state.active || state.locked) finish(!state.locked);
    });
  });
}

async function localVideoId(file: File, size: number) {
  const sampleSize = Math.min(size, 64 * 1024);
  const digest = sha256.create().update(utf8ToBytes(String(size)));
  const handle = file.open();
  try {
    for (const offset of new Set([
      0,
      Math.floor((size - sampleSize) / 2),
      size - sampleSize,
    ])) {
      handle.offset = offset;
      digest.update(await handle.readBytes(sampleSize));
    }
    return "local-video:" + bytesToHex(digest.digest());
  } finally {
    handle.close();
  }
}

export async function openDownloadedVideo(
  id: string,
  { allowProgressive = false, replace = false } = {},
) {
  const local = await initializeLocal();
  if (local.status !== "ready" || !local.isCurrent()) return false;
  const source = local.downloads.get(id);
  if (
    !source ||
    (source.state !== "completed" &&
      !(allowProgressive && local.downloads.canStream(source))) ||
    source.intent ||
    !videoFile(source.name, source.type)
  )
    return false;
  const torrent = torrentsSource.safeParse(source);
  const progressive = source.state !== "completed";
  return local.video.open(
    { kind: "attachment", source, title: source.name },
    torrent.success
      ? {
          progressive,
          replace,
          download: progressive,
          relatedSubtitles: async (signal) => {
            const { torrentId, fileIndex } = torrent.data.payload;
            const files = local.torrents.cached(torrentId)?.files;
            const directory = files
              ?.find((file) => file.index === fileIndex)
              ?.path.slice(0, -1)
              .join("/");
            if (directory === undefined) return [];
            const session = new AbortController();
            const abort = () => session.abort();
            if (signal.aborted) abort();
            signal.addEventListener("abort", abort, { once: true });
            const readersDone = Promise.withResolvers<void>();
            const releases: (() => void)[] = [];
            const selected: { name: string; uri: string; size?: number }[] = [];
            try {
              for (const sibling of local.downloads.snapshot()) {
                if (selected.length >= 12 || session.signal.aborted) break;
                if (
                  sibling.state !== "completed" ||
                  sibling.id === id ||
                  !relatedSubtitle(source.name, sibling.name)
                )
                  continue;
                const match = torrentsSource.safeParse(sibling);
                if (
                  !match.success ||
                  match.data.payload.torrentId !== torrentId ||
                  files
                    ?.find(
                      (file) => file.index === match.data.payload.fileIndex,
                    )
                    ?.path.slice(0, -1)
                    .join("/") !== directory
                )
                  continue;
                const release = local.downloads.holdForPlayback(sibling, () => {
                  abort();
                  return readersDone.promise;
                });
                if (!release) continue;
                releases.push(release);
                await local.downloads.open(sibling.id, async (file) => {
                  selected.push({
                    name: file.name,
                    uri: localMediaUri(file.path),
                    size: sibling.total ?? undefined,
                  });
                });
              }
              return await readSelectedSubtitles(selected, {
                relatedTo: source.name,
                signal: session.signal,
              });
            } finally {
              signal.removeEventListener("abort", abort);
              for (const release of releases) release();
              readersDone.resolve();
            }
          },
        }
      : undefined,
  );
}

export async function openLocalVideo(
  uri: string,
  name?: string,
  mimeType?: string,
  relatedSubtitles?: (signal: AbortSignal) => Promise<SubtitleInput[]>,
) {
  const local = await initializeLocal();
  if (
    local.status !== "ready" ||
    !local.isCurrent() ||
    importing ||
    !isScopedVideoUri(uri) ||
    !(await waitForActive(local.lock)) ||
    importing
  )
    return false;
  const imported = new File(uri);
  const title = imported.name || name || "Video";
  const type = imported.type || mimeType || "application/octet-stream";
  if (!videoFile(title, type) && !videoFile(name ?? title, mimeType ?? type))
    return false;
  const size = imported.size;
  if (!size || size > 1024 ** 3 || size > Paths.availableDiskSpace)
    return false;
  // Keep the import in the private cache for the lifetime of its native decoder.
  const directory = videoImportDirectory();
  directory.create({ intermediates: true, idempotent: true });
  const extension =
    /\.[a-z0-9]{1,12}$/iu.exec(name ?? title)?.[0].toLowerCase() ?? "";
  const file = new File(directory, randomUUID() + extension);
  const dispose = () => {
    if (file.exists) file.delete();
  };
  let transferred = false;
  importing = true;
  try {
    await imported.copy(file);
    if (
      !local.isCurrent() ||
      local.lock.getState().locked ||
      file.size !== size
    )
      return false;
    const path = decodeURIComponent(file.uri.slice("file://".length));
    const info = await marmot
      .inspectMediaFile(path, false, false)
      .catch(() => undefined);
    if (!info?.dimensions || !local.isCurrent() || local.lock.getState().locked)
      return false;
    const id = await localVideoId(file, size);
    if (
      !local.isCurrent() ||
      !local.lock.getState().active ||
      local.lock.getState().locked
    )
      return false;
    transferred = true;
    return await local.video.open(
      {
        kind: "local",
        id,
        file: {
          path,
          name: name ?? title,
          type: type.startsWith("video/") ? type : "video/*",
        },
        title: name ?? title,
        dimensions: info.dimensions,
        duration: info.duration ?? undefined,
      },
      { dispose, relatedSubtitles },
    );
  } finally {
    importing = false;
    if (!transferred) dispose();
  }
}
