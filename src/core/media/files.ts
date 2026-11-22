import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import type { AvatarDisk } from "../avatars/service";

export function removeMediaFile(file: File | Directory) {
  try {
    if (file.exists) file.delete();
  } catch {
    // Startup reclaims abandoned files.
  }
}

export function sweepFiles(directory: Directory, retained: Set<string>) {
  if (!directory.exists) return;
  for (const entry of directory.list())
    if (entry instanceof File && !retained.has(entry.name))
      removeMediaFile(entry);
}

function sweepRetiredOwners(root: Directory, owner: string) {
  if (!root.exists) return;
  for (const entry of root.list())
    if (
      entry instanceof Directory &&
      entry.name !== owner &&
      /^[a-f0-9]{64}$/u.test(entry.name)
    )
      removeMediaFile(entry);
}

const filename = /^[a-f0-9-]{36}\.jpg$/u;

export function profileFiles(owner: string) {
  const cacheRoot = new Directory(Paths.document, "avatar-cache");
  const localRoot = new Directory(Paths.document, "avatar-local");
  const cache = new Directory(cacheRoot, owner);
  const localDirectory = new Directory(localRoot, owner);

  function lookup(directory: Directory, name: string) {
    if (!filename.test(name)) return;
    const file = new File(directory, name);
    return file.exists && file.size > 0 ? file.uri : undefined;
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
      source.copySync(new File(localDirectory, name));
    },
    removeCached(name) {
      if (filename.test(name)) removeMediaFile(new File(cache, name));
    },
    removeLocal(name) {
      if (filename.test(name)) removeMediaFile(new File(localDirectory, name));
    },
    clearCache() {
      if (cache.exists) cache.delete();
    },
    sweep(cacheFiles, localFiles) {
      sweepFiles(cache, cacheFiles);
      sweepFiles(localDirectory, localFiles);
      sweepRetiredOwners(cacheRoot, owner);
      sweepRetiredOwners(localRoot, owner);
    },
  };
  return { disk, localDirectory };
}
