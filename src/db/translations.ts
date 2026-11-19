import { and, eq, getTableColumns, inArray, isNull } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

const { messages, messageTranslations } = schema;
export type TranslationRow = typeof messageTranslations.$inferInsert;
export const translationEngine = "mlkit-v1";
const liveIncoming = and(
  eq(messages.direction, "incoming"),
  isNull(messages.deletedAt),
);

export function createTranslationCache<TResult>(
  db: BaseSQLiteDatabase<"sync", TResult, typeof schema>,
) {
  return {
    read(ids: string[], target: string) {
      if (!ids.length) return [];
      return db
        .select(getTableColumns(messageTranslations))
        .from(messageTranslations)
        .innerJoin(messages, eq(messages.id, messageTranslations.messageId))
        .where(
          and(
            inArray(messageTranslations.messageId, ids),
            eq(messageTranslations.targetLanguage, target),
            eq(messageTranslations.engine, translationEngine),
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
              messageTranslations.contentHash,
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
