import { and, asc, eq } from "drizzle-orm";
import { File } from "expo-file-system";
import type { Database } from "@/db";
import { attachmentCache } from "@/db/schema";
import { cacheEvictions } from "./cache-policy";
import {
  type attachmentFiles,
  removeMediaFile as remove,
  sweepFiles,
} from "./files";

const maxCacheBytes = 128 * 1024 * 1024;
type Source = "sent" | "download";

export function createBlobCache(
  db: Database,
  owner: string,
  { blobs, work }: ReturnType<typeof attachmentFiles>,
) {
  const leases = new Map<string, number>();
  const pendingRemoval = new Set<string>();
  const fileKey = (hash: string, source: Source) => `${source}:${hash}`;

  function location(hash: string, source: Source) {
    return new File(blobs, `${source}-${hash}.bin`);
  }

  function cacheKey(hash: string, source: Source) {
    return and(
      eq(attachmentCache.owner, owner),
      eq(attachmentCache.hash, hash),
      eq(attachmentCache.source, source),
    );
  }

  function entries(source: Source) {
    return db
      .select()
      .from(attachmentCache)
      .where(
        and(
          eq(attachmentCache.owner, owner),
          eq(attachmentCache.source, source),
        ),
      )
      .orderBy(asc(attachmentCache.accessedAt))
      .all();
  }

  function drop(hash: string, source: Source) {
    const key = fileKey(hash, source);
    if (leases.has(key)) {
      pendingRemoval.add(key);
      return;
    }
    db.delete(attachmentCache).where(cacheKey(hash, source)).run();
    remove(location(hash, source));
    pendingRemoval.delete(key);
  }

  function local(hash: string, source: Source) {
    if (pendingRemoval.has(fileKey(hash, source))) return;
    const item = db
      .select()
      .from(attachmentCache)
      .where(cacheKey(hash, source))
      .get();
    if (!item) return;
    const file = location(hash, source);
    if (file.exists && file.size === item.size) return file;
  }

  function reserve(
    size: number,
    source: Source,
    pin?: (hash: string) => boolean,
  ) {
    const { evict, remainingBytes } = cacheEvictions(
      entries(source),
      { maxBytes: maxCacheBytes - size },
      (item) =>
        leases.has(fileKey(item.hash, source)) || pin?.(item.hash) === true,
    );
    if (remainingBytes + size > maxCacheBytes) throw new Error("media-storage");
    for (const item of evict) drop(item.hash, source);
  }

  function promote(
    temp: File,
    hash: string,
    source: Source,
    pin?: (hash: string) => boolean,
  ) {
    const size = temp.size;
    if (!temp.exists || size <= 0) throw new Error("media-storage");
    if (local(hash, source)) return;
    if (leases.has(fileKey(hash, source))) throw new Error("media-storage");
    drop(hash, source);
    reserve(size, source, pin);
    blobs.create({ idempotent: true, intermediates: true });
    const target = location(hash, source);
    new File(temp.uri).moveSync(target);
    try {
      db.insert(attachmentCache)
        .values({ owner, hash, source, size, accessedAt: Date.now() })
        .run();
    } catch (error) {
      remove(target);
      throw error;
    }
  }

  return {
    work,
    get: local,
    promote,
    remove: drop,
    retain(hash: string, source: Source) {
      const key = fileKey(hash, source);
      leases.set(key, (leases.get(key) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = leases.get(key) ?? 0;
        if (count > 1) leases.set(key, count - 1);
        else {
          leases.delete(key);
          if (pendingRemoval.has(key)) drop(hash, source);
        }
      };
    },
    touch(hash: string, source: Source) {
      db.update(attachmentCache)
        .set({ accessedAt: Date.now() })
        .where(cacheKey(hash, source))
        .run();
    },
    sweep(retainSent: (hash: string) => boolean) {
      const known = new Set<string>();
      for (const source of ["sent", "download"] as const) {
        for (const item of entries(source)) {
          const file = local(item.hash, source);
          if (file && (source === "download" || retainSent(item.hash)))
            known.add(file.name);
          else drop(item.hash, source);
        }
      }
      sweepFiles(blobs, known);
    },
    usage(source: Source) {
      return entries(source).reduce(
        (total, item) => total + (local(item.hash, source)?.size ?? 0),
        0,
      );
    },
    clear(source: Source) {
      for (const item of entries(source)) drop(item.hash, source);
    },
  };
}
