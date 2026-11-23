import { gcm } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import { and, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  downloadId,
  jobSchema,
  type DownloadJob,
} from "@/core/downloads/types";
import { downloads } from "./schema";
import type * as schema from "./schema";

export function downloadStore<Result>(
  db: BaseSQLiteDatabase<"sync", Result, typeof schema>,
  account: string,
  key: Uint8Array,
  randomBytes: (count: number) => Uint8Array,
) {
  const owned = eq(downloads.account, account);
  const rowId = (id: string) => bytesToHex(sha256(utf8ToBytes(id)));
  const aad = (id: string) => utf8ToBytes(JSON.stringify([1, account, id]));

  function seal(job: DownloadJob, id: string) {
    const nonce = randomBytes(12);
    const cipher = gcm(key, nonce, aad(id));
    return bytesToHex(
      concatBytes(nonce, cipher.encrypt(utf8ToBytes(JSON.stringify(job)))),
    );
  }

  return {
    load: () =>
      db
        .select()
        .from(downloads)
        .where(owned)
        .all()
        .flatMap(({ id, job }) => {
          try {
            const payload = hexToBytes(job);
            if (payload.length < 29) return [];
            const cipher = gcm(key, payload.subarray(0, 12), aad(id));
            const plaintext = new TextDecoder().decode(
              cipher.decrypt(payload.subarray(12)),
            );
            const decoded = jobSchema.parse(JSON.parse(plaintext));
            return rowId(decoded.id) === id &&
              downloadId(decoded.target) === decoded.id
              ? [decoded]
              : [];
          } catch {
            return [];
          }
        }),
    save(jobs: DownloadJob[]) {
      db.transaction((tx) => {
        for (const row of jobs) {
          const id = rowId(row.id);
          const job = seal(row, id);
          tx.insert(downloads)
            .values({ account, id, job })
            .onConflictDoUpdate({
              target: [downloads.account, downloads.id],
              set: { job },
            })
            .run();
        }
      });
    },
    clear() {
      db.delete(downloads).where(owned).run();
    },
    remove(id: string) {
      db.delete(downloads)
        .where(and(owned, eq(downloads.id, rowId(id))))
        .run();
    },
  };
}
