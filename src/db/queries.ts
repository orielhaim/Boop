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
  name: string,
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
    Pick<typeof schema.contacts.$inferInsert, "favorite" | "allowIncomingVideo">
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
      avatarUrl: schema.contacts.avatarUrl,
    })
    .from(schema.callHistory)
    .leftJoin(
      schema.contacts,
      eq(schema.callHistory.peerKey, schema.contacts.publicKey),
    )
    .orderBy(desc(schema.callHistory.startedAt))
    .limit(100);
}
