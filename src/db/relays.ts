import { eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  defaultRelays,
  inboxIntentKey,
  type RelayChoice,
} from "@/core/nostr/config";
import { preference, setPreference } from "@/db/queries";
import type * as schema from "@/db/schema";
import { relaySettings } from "@/db/schema";

type RelayDatabase<TResult> = Pick<
  BaseSQLiteDatabase<"sync", TResult, typeof schema>,
  "select" | "insert" | "transaction"
>;

const initializedKey = "relay.settings.initialized";

export function seedRelays<TResult>(
  db: RelayDatabase<TResult>,
  newIdentity: boolean,
) {
  if (preference(db, initializedKey)) return;
  db.transaction((tx) => {
    if (!tx.select().from(relaySettings).limit(1).get()) {
      tx.insert(relaySettings).values(defaultRelays).run();
      if (newIdentity) setPreference(tx, inboxIntentKey, "initial");
    }
    setPreference(tx, initializedKey, "1");
  });
}

export function editRelays<TResult>(
  db: RelayDatabase<TResult>,
  changes: readonly { url: string; next: RelayChoice | null }[],
  intent: string | null,
) {
  db.transaction((tx) => {
    for (const { url, next } of changes) {
      if (next)
        tx.insert(relaySettings)
          .values(next)
          .onConflictDoUpdate({ target: relaySettings.url, set: next })
          .run();
      else tx.delete(relaySettings).where(eq(relaySettings.url, url)).run();
    }
    if (intent) setPreference(tx, inboxIntentKey, intent);
  });
}
