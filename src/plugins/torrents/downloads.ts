import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { audioFile } from "@/core/audio/types";
import type { DownloadTransport } from "@/core/downloads/transport";
import {
  sourceId,
  torrentsSource,
  type ProviderDownload,
  type TorrentsDownload,
} from "@/core/downloads/types";
import { videoFile } from "@/core/video/types";
import type { TorrentFile } from "./contracts";
import type { Torrents } from "./service";
import { torrents as registration } from "./descriptor";

const mediaTypes: Record<string, string> = {
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  opus: "audio/ogg",
  wav: "audio/wav",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  pdf: "application/pdf",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  ass: "text/x-ssa",
  ssa: "text/x-ssa",
};

export function torrentDownload(
  torrentId: string,
  file: TorrentFile,
): TorrentsDownload {
  const name = file.path.at(-1) ?? String(file.index);
  const extension = /\.([a-z0-9]{1,12})$/iu.exec(name)?.[1].toLowerCase();
  const type =
    (extension && mediaTypes[extension]) ||
    (videoFile(name, "")
      ? "video/*"
      : audioFile(name, "")
        ? "audio/*"
        : "application/octet-stream");
  return {
    kind: "provider",
    provider: "torrents",
    version: 1,
    payload: { torrentId, fileIndex: file.index },
    name,
    total: file.size,
    type,
    expiresAt: null,
  };
}

export function torrentDirectory(scope: string) {
  if (!/^[a-f0-9]{64}$/u.test(scope)) throw new Error("InvalidTorrentScope");
  return new Directory(Paths.document, "torrent-downloads", scope);
}

export function createTorrentDownloads(
  scope: string,
  torrents: Torrents,
  hasSibling: (source: TorrentsDownload) => boolean,
): DownloadTransport<ProviderDownload> {
  const root = torrentDirectory(scope);
  const active = new Map<
    string,
    { abort: AbortController; done: Promise<string>; reserved: number }
  >();
  function file(source: TorrentsDownload, suffix = "complete") {
    const { torrentId, fileIndex } = source.payload;
    return new File(root, torrentId, `${fileIndex}.${suffix}`);
  }
  function size(source: TorrentsDownload) {
    const retained = file(source);
    return retained.exists &&
      source.total !== null &&
      retained.size === source.total
      ? retained.size
      : null;
  }
  function remove(file: File | Directory) {
    if (file.exists) file.delete();
  }

  return {
    supportedVersions: registration.descriptor.downloadProvider.versions,
    available(source) {
      return torrentsSource.safeParse(source).success;
    },
    async recover(sources) {
      if (!root.exists) return;
      const owned = new Set(
        sources.flatMap((source) => {
          const parsed = torrentsSource.safeParse(source);
          return parsed.success ? [parsed.data.payload.torrentId] : [];
        }),
      );
      const workspace = new Directory(root, ".engine");
      if (workspace.exists)
        for (const directory of workspace.list()) {
          if (
            directory instanceof Directory &&
            /^[a-f0-9]{40}$/u.test(directory.name) &&
            !owned.has(directory.name)
          ) {
            directory.delete();
          }
        }
      for (const directory of root.list()) {
        if (
          directory instanceof Directory &&
          /^[a-f0-9]{40}$/u.test(directory.name) &&
          !owned.has(directory.name)
        ) {
          directory.delete();
        }
      }
    },
    async retainedSize(source) {
      return size(torrentsSource.parse(source));
    },
    async status(source) {
      const target = torrentsSource.parse(source);
      return active.has(sourceId(target))
        ? "downloading"
        : size(target) !== null
          ? "ready"
          : "unavailable";
    },
    async transfer(source, progress, signal) {
      const target = torrentsSource.parse(source);
      if (size(target) !== null) return "ready";
      if (!torrents.canTransfer()) return "unavailable";
      const id = sourceId(target);
      const { torrentId, fileIndex } = target.payload;
      const meta = torrents.cached(torrentId);
      const selected = meta?.files.find((entry) => entry.index === fileIndex);
      if (!meta || !selected || selected.size !== target.total)
        return "integrity";
      const reserved = [...active.values()].reduce(
        (total, job) => total + job.reserved,
        0,
      );
      if (Paths.availableDiskSpace < reserved + selected.size + 64 * 1024 ** 2)
        return "storage_blocked";
      const abort = new AbortController();
      const abortLocal = () => abort.abort();
      signal.addEventListener("abort", abortLocal, { once: true });
      if (signal.aborted) abortLocal();
      const done = torrents
        .run(
          {
            kind: "start",
            requestId: randomUUID(),
            torrentId,
            fileIndex,
            size: selected.size,
            metadata: meta.metadata,
          },
          abort.signal,
          (received) =>
            progress({
              state: "downloading",
              received: Math.min(received, selected.size),
              total: selected.size,
            }),
        )
        .then((result) => {
          if (result.kind === "completed")
            return size(target) !== null ? "ready" : "integrity";
          if (result.kind === "failed") {
            if (result.code === "storage") return "storage_blocked";
            if (result.code === "integrity") return "integrity";
            if (result.code === "unavailable") return "unavailable";
          }
          return "interrupted";
        })
        .finally(() => {
          signal.removeEventListener("abort", abortLocal);
          active.delete(id);
        });
      active.set(id, { abort, done, reserved: selected.size });
      return done;
    },
    async control(source, action) {
      const target = torrentsSource.parse(source);
      const task = active.get(sourceId(target));
      task?.abort.abort();
      await task?.done.catch(() => undefined);
      if (action === "pause") return;
      remove(file(target, "part"));
      if (action === "remove") remove(file(target));
      if (
        !hasSibling(target) &&
        action === "remove" &&
        !(await torrents.forget(target.payload.torrentId))
      )
        return;
      if (!hasSibling(target) && action === "remove") {
        remove(new Directory(root, ".engine", target.payload.torrentId));
        remove(new Directory(root, target.payload.torrentId));
      }
    },
    async open(source, consume) {
      const target = torrentsSource.parse(source);
      if (size(target) === null) return;
      await consume({
        path: decodeURIComponent(file(target).uri.slice(7)),
        name: target.name,
        type: target.type,
      });
    },
  };
}
