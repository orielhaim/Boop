import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNull,
  like,
  ne,
  sql,
} from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import * as schema from "./schema";
import { preference, setPreference } from "./queries";

const { messages, messageTranslations } = schema;
type TranslationRow = typeof messageTranslations.$inferInsert;
const liveIncoming = and(
  eq(messages.direction, "incoming"),
  isNull(messages.deletedAt),
  ne(messages.body, ""),
);

const prefix = "marmot.translation.";
const stored = z.object({
  source: z.string(),
  digest: z.string(),
  body: z.string(),
  until: z.number(),
});
const encoder = new TextEncoder();
const digest = (body: string) => bytesToHex(sha256(encoder.encode(body)));

export function createDerivedTranslations<Result>(
  db: BaseSQLiteDatabase<"sync", Result, typeof schema>,
  incoming: (id: string) => string | undefined,
): ReturnType<typeof createTranslationCache<Result>> {
  let writes = 0;
  const key = (id: string, target: string) => `${prefix}${id}.${target}`;
  return {
    read(ids, target) {
      return ids.flatMap((id) => {
        const original = incoming(id);
        const value = preference(db, key(id, target));
        if (!original || !value) return [];
        try {
          const row = stored.parse(JSON.parse(value));
          if (row.until <= Date.now() || digest(original) !== row.digest)
            return [];
          return [
            {
              messageId: id,
              targetLanguage: target,
              sourceLanguage: row.source,
              translatedText: row.body,
              original,
            },
          ];
        } catch {
          return [];
        }
      });
    },
    matchesIncoming(id, body) {
      return incoming(id) === body;
    },
    store(row, body) {
      if (incoming(row.messageId) !== body) return false;
      const now = Date.now();
      setPreference(
        db,
        key(row.messageId, row.targetLanguage),
        JSON.stringify({
          digest: digest(body),
          source: row.sourceLanguage,
          body: row.translatedText,
          until: now + 7 * 86_400_000,
        }),
      );
      if (++writes % 64 === 1) {
        db.delete(schema.settings)
          .where(
            and(
              like(schema.settings.key, `${prefix}%`),
              sql`json_extract(${schema.settings.value}, '$.until') <= ${now}`,
            ),
          )
          .run();
      }
      return true;
    },
    remove(id, target) {
      db.delete(schema.settings)
        .where(eq(schema.settings.key, key(id, target)))
        .run();
    },
    clear() {
      db.delete(schema.settings)
        .where(like(schema.settings.key, `${prefix}%`))
        .run();
    },
  };
}

export function createTranslationCache<TResult>(
  db: BaseSQLiteDatabase<"sync", TResult, typeof schema>,
) {
  return {
    read(ids: string[], target: string) {
      if (!ids.length) return [];
      return db
        .select({
          ...getTableColumns(messageTranslations),
          original: messages.body,
        })
        .from(messageTranslations)
        .innerJoin(messages, eq(messages.id, messageTranslations.messageId))
        .where(
          and(
            inArray(messageTranslations.messageId, ids),
            eq(messageTranslations.targetLanguage, target),
            liveIncoming,
          ),
        )
        .all()
        .filter(
          (row) => row.translatedText.trim() && row.sourceLanguage !== target,
        );
    },
    matchesIncoming(id: string, body: string) {
      return Boolean(
        db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(eq(messages.id, id), eq(messages.body, body), liveIncoming),
          )
          .get(),
      );
    },
    store(row: TranslationRow, original: string) {
      return db.transaction((tx) => {
        const exists = tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.id, row.messageId),
              eq(messages.body, original),
              liveIncoming,
            ),
          )
          .get();
        if (!exists) return false;
        tx.insert(messageTranslations)
          .values(row)
          .onConflictDoUpdate({
            target: [
              messageTranslations.messageId,
              messageTranslations.targetLanguage,
            ],
            set: row,
          })
          .run();
        return true;
      });
    },
    remove(id: string, target: string) {
      db.delete(messageTranslations)
        .where(
          and(
            eq(messageTranslations.messageId, id),
            eq(messageTranslations.targetLanguage, target),
          ),
        )
        .run();
    },
    clear() {
      db.delete(messageTranslations).run();
    },
  };
}
