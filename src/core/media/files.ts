import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import type { AvatarDisk } from "../avatars/service";
import { cacheEvictions } from "./cache-policy";

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

const localFilename = /^[a-f0-9-]{36}\.jpg$/u;
const cacheFilename = /^[a-f0-9]{64}\.jpg$/u;
const authoredFilename = /^(photo|banner)-[a-f0-9]{64}\.jpg$/u;

export function profileFiles(owner: string) {
  const cacheRoot = new Directory(Paths.document, "avatar-cache");
  const localRoot = new Directory(Paths.document, "avatar-local");
  const cache = new Directory(cacheRoot, owner);
  const localDirectory = new Directory(localRoot, owner);

  function lookup(directory: Directory, name: string) {
    const file = new File(directory, name);
    return file.exists && file.size > 0 ? file.uri : undefined;
  }
  const disk: AvatarDisk = {
    newId: randomUUID,
    cached: (name) =>
      cacheFilename.test(name) || localFilename.test(name)
        ? lookup(cache, name)
        : undefined,
    local: (name) =>
      localFilename.test(name) ? lookup(localDirectory, name) : undefined,
    cacheTarget(name) {
      if (!localFilename.test(name))
        throw new Error("Invalid avatar staging name");
      cache.create({ idempotent: true, intermediates: true });
      return new File(cache, name).uri;
    },
    copyLocal(uri, name) {
      const source = new File(uri);
      localDirectory.create({ idempotent: true, intermediates: true });
      source.copySync(new File(localDirectory, name));
    },
    authored: (field, name) =>
      cacheFilename.test(name)
        ? lookup(localDirectory, `${field}-${name}`)
        : undefined,
    keepAuthored(field, staged, key) {
      const name = key && `${field}-${key}`;
      if (staged) {
        if (
          !localFilename.test(staged) ||
          !name ||
          !authoredFilename.test(name)
        )
          throw new Error("Invalid authored image name");
        const destination = new File(localDirectory, name);
        if (!destination.exists)
          new File(localDirectory, staged).copySync(destination);
      }
      if (!localDirectory.exists) return;
      for (const file of localDirectory.list()) {
        if (
          file instanceof File &&
          file.name !== name &&
          file.name.startsWith(`${field}-`) &&
          authoredFilename.test(file.name)
        )
          removeMediaFile(file);
      }
    },
    removeCached(name) {
      if (localFilename.test(name)) removeMediaFile(new File(cache, name));
    },
    commitCached(staged, name) {
      if (!localFilename.test(staged) || !cacheFilename.test(name))
        throw new Error("Invalid avatar cache name");
      const source = new File(cache, staged);
      const destination = new File(cache, name);
      if (destination.exists) removeMediaFile(source);
      else source.moveSync(destination);
    },
    pruneCache() {
      if (!cache.exists) return;
      const files = cache.list().flatMap((file) =>
        file instanceof File && cacheFilename.test(file.name)
          ? [
              {
                file,
                size: file.size,
                accessedAt: file.modificationTime ?? 0,
              },
            ]
          : [],
      );
      const { evict } = cacheEvictions(
        files.sort((a, b) => a.accessedAt - b.accessedAt),
        {
          maxBytes: 64 * 1024 * 1024,
          maxEntries: 512,
          expiresBefore: Date.now() - 60 * 86_400_000,
        },
      );
      for (const { file } of evict) removeMediaFile(file);
    },
    removeLocal(name) {
      if (localFilename.test(name))
        removeMediaFile(new File(localDirectory, name));
    },
    clearCache() {
      if (cache.exists) cache.delete();
    },
    sweepLocal(localFiles) {
      if (cache.exists)
        for (const entry of cache.list()) {
          if (entry instanceof File && !cacheFilename.test(entry.name))
            removeMediaFile(entry);
        }
      if (localDirectory.exists) {
        for (const entry of localDirectory.list())
          if (entry instanceof File && authoredFilename.test(entry.name))
            localFiles.add(entry.name);
        sweepFiles(localDirectory, localFiles);
      }
      sweepRetiredOwners(cacheRoot, owner);
      sweepRetiredOwners(localRoot, owner);
    },
  };
  return { disk, localDirectory };
}
