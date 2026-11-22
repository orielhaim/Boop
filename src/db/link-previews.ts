import { desc, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { CachedPreview } from "@/core/messaging/link-previews";
import type * as schema from "./schema";
import { linkPreviewCache } from "./schema";

const cacheLimit = 96;

export function openLinkPreviewCache<Result>(
  db: BaseSQLiteDatabase<"sync", Result, typeof schema>,
  remove: (image: string) => void,
) {
  const entries = new Map<string, CachedPreview>();
  const rows = db
    .select()
    .from(linkPreviewCache)
    .orderBy(desc(linkPreviewCache.fetchedAt))
    .all();
  for (const row of rows) {
    entries.set(row.url, {
      ...row,
      siteName: row.siteName ?? new URL(row.url).hostname,
      title: row.title ?? undefined,
      description: row.description ?? undefined,
      image: row.image ?? undefined,
    });
  }
  function prune() {
    const now = Date.now();
    const sorted = [...entries.values()].sort(
      (a, b) => b.fetchedAt - a.fetchedAt,
    );
    for (const [index, row] of sorted.entries()) {
      if (index < cacheLimit && row.expiresAt > now) continue;
      db.delete(linkPreviewCache)
        .where(eq(linkPreviewCache.url, row.url))
        .run();
      entries.delete(row.url);
      if (row.image) remove(row.image);
    }
  }
  prune();
  return {
    clear() {
      db.delete(linkPreviewCache).run();
      const removed = [...entries.values()];
      entries.clear();
      for (const entry of removed) if (entry.image) remove(entry.image);
    },
    cached(url: string) {
      const entry = entries.get(url);
      return entry && entry.expiresAt > Date.now() ? entry : undefined;
    },
    save(row: CachedPreview) {
      const values = {
        ...row,
        title: row.title ?? null,
        description: row.description ?? null,
        image: row.image ?? null,
      };
      const old = entries.get(row.url);
      db.insert(linkPreviewCache)
        .values(values)
        .onConflictDoUpdate({ target: linkPreviewCache.url, set: values })
        .run();
      entries.set(row.url, row);
      if (old?.image && old.image !== row.image) remove(old.image);
      prune();
    },
    images: () =>
      new Set(
        [...entries.values()].flatMap(({ image }) => (image ? [image] : [])),
      ),
  };
}
