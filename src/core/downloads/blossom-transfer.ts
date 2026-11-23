import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Directory, File, Paths } from "expo-file-system";
import { downloadBlossomFile } from "../media/download-native";
import {
  blossomCandidates,
  checkedBlossomUrls,
  tryBlossomOrigins,
} from "./blossom";
import type { DownloadTransport } from "./transport";
import type { BlossomDownload } from "./types";

function errorState(error: unknown) {
  const message =
    error instanceof Error
      ? `${"code" in error ? error.code : ""} ${error.message}`
      : "";
  if (/storage|ENOSPC|no space left/i.test(message)) return "storage_blocked";
  if (
    /integrity|hash mismatch|length mismatch|MEDIA_RANGE|MEDIA_TOO_LARGE/i.test(
      message,
    )
  )
    return "integrity";
  if (
    /missing|unavailable|unsupported|policy|redirect|destination|HTTP_PERMANENT|HTTP[ _](?:4(?:0[0134]|10|16)|3\d\d)/i.test(
      message,
    )
  )
    return "unavailable";
  return "interrupted";
}

export function createBlossomDownloads(
  scope: string,
  configured: () => string[],
  discoverServers: (author: string) => Promise<string[]>,
): DownloadTransport<BlossomDownload> {
  const root = new Directory(Paths.document, "blossom-downloads");
  const directory = new Directory(root, scope);
  const file = (hash: string) => new File(directory, `${hash}.bin`);
  const partial = (hash: string) => new File(directory, `${hash}.bin.download`);
  const verified = new Map<string, { size: number; modified: number | null }>();
  const active = new Map<
    string,
    { abort: AbortController; done: Promise<string> }
  >();

  async function checkedSize(source: BlossomDownload) {
    const local = file(source.hash);
    const { exists, size, modificationTime } = local;
    if (!exists) return null;
    const cached = verified.get(source.hash);
    if (
      !cached ||
      cached.size !== size ||
      cached.modified !== modificationTime
    ) {
      const reader = local.open();
      const digest = sha256.create();
      let received = 0;
      try {
        while (received < size && received < 1024 ** 3) {
          const bytes = await reader.readBytes(
            Math.min(256 * 1024, size - received),
          );
          if (!bytes.length) break;
          digest.update(bytes);
          received += bytes.length;
        }
      } finally {
        reader.close();
      }
      if (received !== size || bytesToHex(digest.digest()) !== source.hash) {
        if (
          local.exists &&
          local.size === size &&
          local.modificationTime === modificationTime
        )
          local.delete();
        verified.delete(source.hash);
        return null;
      }
      verified.set(source.hash, { size, modified: modificationTime });
    }
    return size;
  }

  return {
    retainedSize: checkedSize,
    async recover(owned) {
      if (!root.exists) return;
      const hashes = new Set(owned.map((source) => source.hash));
      for (const folder of root.list()) {
        if (
          !(folder instanceof Directory) ||
          !/^[a-f0-9]{64}$/u.test(folder.name)
        )
          continue;
        if (folder.name !== scope) folder.delete();
        else
          for (const entry of folder.list()) {
            const match = /^([a-f0-9]{64})\.bin(?:\.download)?$/u.exec(
              entry.name,
            );
            if (match && !hashes.has(match[1])) entry.delete();
          }
      }
    },
    async status(source) {
      if (active.has(source.hash)) return "downloading";
      const size = await checkedSize(source);
      if (size === null) return "unavailable";
      return source.expectedSize === null || size === source.expectedSize
        ? "ready"
        : "integrity";
    },
    async transfer(source, progress, signal) {
      if (signal.aborted) return "interrupted";
      const prior = active.get(source.hash);
      if (prior) return prior.done;
      const abort = new AbortController();
      const stop = () => abort.abort();
      signal.addEventListener("abort", stop, { once: true });
      const done = Promise.resolve()
        .then(async () => {
          const size = await checkedSize(source);
          if (abort.signal.aborted) return "interrupted";
          if (size !== null) {
            if (source.expectedSize !== null && size !== source.expectedSize)
              return "integrity";
            progress({ state: "ready", received: size, total: size });
            return "ready";
          }
          directory.create({ intermediates: true, idempotent: true });
          return tryBlossomOrigins(
            checkedBlossomUrls(source),
            async () => {
              const lists = await Promise.all(
                source.authors.map((author) =>
                  discoverServers(author).catch(() => []),
                ),
              );
              return blossomCandidates(source.hash, [
                ...lists.flat(),
                ...configured(),
              ]);
            },
            async (url) => {
              try {
                const size = await downloadBlossomFile(
                  url,
                  file(source.hash).uri,
                  source.hash,
                  source.expectedSize,
                  (received, total) =>
                    progress({ state: "downloading", received, total }),
                  abort.signal,
                );
                if (abort.signal.aborted) return "interrupted";
                verified.set(source.hash, {
                  size,
                  modified: file(source.hash).modificationTime,
                });
                progress({ state: "ready", received: size, total: size });
                return "ready";
              } catch (error) {
                return abort.signal.aborted ? "interrupted" : errorState(error);
              }
            },
            abort.signal,
          );
        })
        .catch(errorState)
        .finally(() => {
          signal.removeEventListener("abort", stop);
          active.delete(source.hash);
        });
      active.set(source.hash, { abort, done });
      return done;
    },
    async control(source, action) {
      const current = active.get(source.hash);
      current?.abort.abort();
      await current?.done;
      if (action !== "pause" && partial(source.hash).exists)
        partial(source.hash).delete();
      if (action === "remove") {
        if (file(source.hash).exists) file(source.hash).delete();
        verified.delete(source.hash);
      }
    },
    async open(source, consume) {
      const size = await checkedSize(source);
      if (
        size === null ||
        (source.expectedSize !== null && size !== source.expectedSize)
      )
        throw new Error("MediaUnavailable");
      await consume({
        path: decodeURIComponent(file(source.hash).uri.slice("file://".length)),
        type: source.type,
        name: source.name,
      });
    },
  };
}
