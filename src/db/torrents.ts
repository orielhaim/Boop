import { gcm } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import { asc, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  torrentMetadata,
  type TorrentMetadata,
} from "@/plugins/torrents/contracts";
import { torrentCache } from "./schema";
import type * as schema from "./schema";

const maxEntries = 64;
const maxBytes = 8 * 1024 * 1024;

export function torrentMetadataCache<Result>(
  db: BaseSQLiteDatabase<"sync", Result, typeof schema>,
  key: Uint8Array,
  randomBytes: (count: number) => Uint8Array,
) {
  const id = (hash: string) =>
    bytesToHex(hmac(sha256, key, utf8ToBytes(`torrent:${hash}`)));
  function cipher(nonce: Uint8Array, row: string) {
    return gcm(key, nonce, utf8ToBytes(`torrent:1:${row}`));
  }
  function reduce(pinned: readonly string[], preserve?: string) {
    const keep = new Set(pinned.map(id));
    if (preserve) keep.add(preserve);
    const rows = db
      .select({ id: torrentCache.id, bytes: torrentCache.bytes })
      .from(torrentCache)
      .orderBy(asc(torrentCache.touched))
      .all();
    let bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    let count = rows.length;
    for (const row of rows) {
      if (keep.has(row.id)) continue;
      if (preserve && bytes <= maxBytes && count <= maxEntries) break;
      db.delete(torrentCache).where(eq(torrentCache.id, row.id)).run();
      count--;
      bytes -= row.bytes;
    }
    return bytes <= maxBytes && count <= maxEntries;
  }
  return {
    get(hash: string) {
      const rowId = id(hash);
      const row = db
        .select()
        .from(torrentCache)
        .where(eq(torrentCache.id, rowId))
        .get();
      if (!row || row.sealed.length > maxBytes) return;
      try {
        const data = hexToBytes(row.sealed);
        const plaintext = cipher(data.subarray(0, 12), rowId).decrypt(
          data.subarray(12),
        );
        const metadata = torrentMetadata.parse(
          JSON.parse(new TextDecoder().decode(plaintext)),
        );
        if (metadata.torrentId !== hash) return;
        db.update(torrentCache)
          .set({ touched: Date.now() })
          .where(eq(torrentCache.id, rowId))
          .run();
        return metadata;
      } catch {
        return undefined;
      }
    },
    put(metadata: TorrentMetadata, pinned: readonly string[]) {
      const rowId = id(metadata.torrentId);
      const nonce = randomBytes(12);
      const payload = cipher(nonce, rowId).encrypt(
        utf8ToBytes(JSON.stringify(metadata)),
      );
      const sealed = bytesToHex(concatBytes(nonce, payload));
      const row = {
        id: rowId,
        sealed,
        bytes: sealed.length,
        touched: Date.now(),
      };
      db.transaction(() => {
        db.insert(torrentCache)
          .values(row)
          .onConflictDoUpdate({ target: torrentCache.id, set: row })
          .run();
        if (!reduce(pinned, rowId)) {
          db.delete(torrentCache).where(eq(torrentCache.id, rowId)).run();
          throw new Error("TorrentCacheFull");
        }
      });
    },
    clear(pinned: readonly string[]) {
      db.transaction(() => {
        reduce(pinned);
      });
    },
    bytes() {
      return db
        .select({ bytes: torrentCache.bytes })
        .from(torrentCache)
        .all()
        .reduce((total, row) => total + row.bytes, 0);
    },
  };
}
