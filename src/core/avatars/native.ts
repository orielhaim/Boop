import { requireOptionalNativeModule } from "expo";
import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import type { AvatarDisk, AvatarTransport } from "./service";

type NativeAvatarTransport = AvatarTransport & {
  prepare(id: string): void;
  available(): boolean;
};
const native = requireOptionalNativeModule<NativeAvatarTransport>(
  "BoopAvatarTransport",
);

export const nativeAvatarTransport: AvatarTransport | null =
  native?.available?.() && native
    ? {
        download(id, url, destination, hash) {
          native.prepare(id);
          return native.download(id, url, destination, hash);
        },
        cancel(id) {
          native.cancel(id);
        },
      }
    : null;

const filename = /^[a-f0-9-]{36}\.jpg$/u;

export function avatarDisk(owner: string) {
  const cacheRoot = new Directory(Paths.document, "avatar-cache");
  const localRoot = new Directory(Paths.document, "avatar-local");
  const cache = new Directory(cacheRoot, owner);
  const localDirectory = new Directory(localRoot, owner);

  function lookup(directory: Directory, name: string) {
    if (!filename.test(name)) return;
    const file = new File(directory, name);
    return file.exists && file.size > 0 ? file.uri : undefined;
  }
  function remove(file: File | Directory) {
    try {
      if (file.exists) file.delete();
    } catch {
      // Reclaim orphans during the next startup sweep.
    }
  }
  function sweepFiles(directory: Directory, retained: Set<string>) {
    if (directory.exists)
      for (const entry of directory.list()) {
        if (entry instanceof File && !retained.has(entry.name)) remove(entry);
      }
  }

  const disk: AvatarDisk = {
    newId: randomUUID,
    cached: (name) => lookup(cache, name),
    local: (name) => lookup(localDirectory, name),
    cacheTarget(name) {
      cache.create({ idempotent: true, intermediates: true });
      return new File(cache, name).uri;
    },
    copyLocal(uri, name) {
      const source = new File(uri);
      localDirectory.create({ idempotent: true, intermediates: true });
      source.copy(new File(localDirectory, name));
    },
    removeCached(name) {
      if (filename.test(name)) remove(new File(cache, name));
    },
    removeLocal(name) {
      if (filename.test(name)) remove(new File(localDirectory, name));
    },
    clearCache() {
      if (cache.exists) cache.delete();
    },
    sweep(cacheFiles, localFiles) {
      sweepFiles(cache, cacheFiles);
      sweepFiles(localDirectory, localFiles);
      for (const parent of [cacheRoot, localRoot]) {
        if (!parent.exists) continue;
        for (const entry of parent.list()) {
          if (
            entry instanceof Directory &&
            entry.name !== owner &&
            /^[0-9a-f]{64}$/u.test(entry.name)
          )
            remove(entry);
        }
      }
    },
  };
  return { disk, localDirectory };
}
