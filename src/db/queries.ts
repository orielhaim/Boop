import { desc, eq, getTableColumns } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

type ReadyDatabase<TResult> = Pick<
  BaseSQLiteDatabase<"sync", TResult, typeof schema>,
  "select" | "insert"
>;

export function contactByKey<TResult>(
  db: ReadyDatabase<TResult>,
  publicKey: string,
) {
  return db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.publicKey, publicKey));
}

export function saveContact<TResult>(
  db: ReadyDatabase<TResult>,
  publicKey: string,
  name = "",
) {
  return db
    .insert(schema.contacts)
    .values({ publicKey, name })
    .onConflictDoNothing({ target: schema.contacts.publicKey })
    .run();
}

export function updateContactPreferences<TResult>(
  db: Pick<BaseSQLiteDatabase<"sync", TResult, typeof schema>, "update">,
  publicKey: string,
  patch: Partial<
    Pick<
      typeof schema.contacts.$inferInsert,
      "name" | "favorite" | "allowIncomingVideo"
    >
  >,
) {
  return db
    .update(schema.contacts)
    .set(patch)
    .where(eq(schema.contacts.publicKey, publicKey))
    .run();
}

export function preference<TResult>(db: ReadyDatabase<TResult>, key: string) {
  return (
    db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()
      ?.value ?? null
  );
}

export function setPreference<TResult>(
  db: ReadyDatabase<TResult>,
  key: string,
  value: string,
) {
  db.insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value },
    })
    .run();
}

export function callList<TResult>(db: ReadyDatabase<TResult>) {
  return db
    .select({
      ...getTableColumns(schema.callHistory),
      name: schema.contacts.name,
    })
    .from(schema.callHistory)
    .leftJoin(
      schema.contacts,
      eq(schema.callHistory.peerKey, schema.contacts.publicKey),
    )
    .orderBy(desc(schema.callHistory.startedAt))
    .limit(100);
}

export function callById<TResult>(db: ReadyDatabase<TResult>, id: string) {
  return db
    .select()
    .from(schema.callHistory)
    .where(eq(schema.callHistory.id, id))
    .get();
}

export function saveCallRecord<TResult>(
  db: Pick<BaseSQLiteDatabase<"sync", TResult, typeof schema>, "transaction">,
  entry: typeof schema.callHistory.$inferInsert,
) {
  db.transaction((tx) => {
    const prior = callById(tx, entry.id);
    if (!prior) {
      tx.insert(schema.callHistory).values(entry).run();
      return;
    }
    if (
      !entry.invitationIds?.length ||
      entry.invitationIds.some((id) => prior.invitationIds.includes(id))
    )
      return;
    tx.update(schema.callHistory)
      .set({
        invitationIds: [...prior.invitationIds, ...entry.invitationIds].slice(
          -32,
        ),
        participantKeys: [
          ...new Set([
            ...prior.participantKeys,
            ...(entry.participantKeys ?? []),
          ]),
        ],
        answeredAt: prior.answeredAt ?? entry.answeredAt,
        endedAt: entry.endedAt,
        durationSeconds: prior.durationSeconds + (entry.durationSeconds ?? 0),
        outcome:
          prior.answeredAt !== null && entry.answeredAt == null
            ? prior.outcome
            : entry.outcome,
      })
      .where(eq(schema.callHistory.id, entry.id))
      .run();
  });
}
