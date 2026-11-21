import { eq, notInArray } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { preference, setPreference } from "@/db/queries";
import type * as schema from "@/db/schema";
import {
  avatarCache,
  nostrProfiles,
  blockedIdentities,
  callHistory,
  communicationGrants,
  contacts,
  conversations,
  messageReactions,
  messageRequests,
  attachmentCache,
  messages,
  settings,
} from "@/db/schema";
import { deriveIdentity, loadIdentity, parsePublicKey } from "./keys";

const key = "boop.identity.v1";
const pinned = "identity.publicKey";
const activeSlot = "identity.activeSlot";
const pendingSwitch = "identity.pendingSwitch";
const retiredSlot = "identity.retiredSlot";
type Storage = {
  read: (slot: string) => Promise<string | null>;
  write: (slot: string, value: string) => Promise<void>;
  remove: (slot: string) => Promise<void>;
};
type IdentityDatabase<TResult> = BaseSQLiteDatabase<
  "sync",
  TResult,
  typeof schema
>;

const slot = (publicKey: string) => `${key}.${publicKey}`;
const currentSlot = <TResult>(db: IdentityDatabase<TResult>) => {
  const saved = preference(db, activeSlot);
  if (saved === null) return key;
  if (saved !== preference(db, pinned) || parsePublicKey(saved) !== saved)
    throw new Error("Identity slot mismatch");
  return slot(saved);
};

export async function storedSecret<TResult>(
  db: IdentityDatabase<TResult>,
  storage: Storage,
) {
  const secret = await storage.read(currentSlot(db));
  if (!secret || deriveIdentity(secret).publicKey !== preference(db, pinned))
    throw new Error("Identity mismatch");
  return secret;
}

export async function stageSwitch<TResult>(
  db: IdentityDatabase<TResult>,
  storage: Storage,
  secret: string,
) {
  const { publicKey } = deriveIdentity(secret);
  const previous = preference(db, pinned);
  if (!previous) throw new Error("Identity missing");
  if (publicKey === previous) {
    const existing = await storedSecret(db, storage);
    if (existing !== secret) throw new Error("Identity mismatch");
    return "same";
  }
  if (preference(db, pendingSwitch))
    throw new Error("Identity replacement already staged");
  await storage.write(slot(publicKey), secret);
  if ((await storage.read(slot(publicKey))) !== secret)
    throw new Error("Identity staging failed");
  setPreference(db, pendingSwitch, publicKey);
  return "staged";
}

async function recoverSwitch<TResult>(
  db: IdentityDatabase<TResult>,
  storage: Storage,
) {
  const pending = preference(db, pendingSwitch);
  if (pending) {
    const previous = preference(db, pinned);
    if (
      !previous ||
      parsePublicKey(pending) !== pending ||
      pending === previous
    )
      throw new Error("Invalid identity switch");
    let candidate: string | null;
    try {
      candidate = await storage.read(slot(pending));
    } catch {
      return;
    }
    let valid = false;
    try {
      valid =
        candidate !== null && deriveIdentity(candidate).publicKey === pending;
    } catch {
      valid = false;
    }
    if (valid) {
      const oldSlot = currentSlot(db);
      try {
        db.transaction((tx) => {
          tx.delete(messageReactions).run();
          tx.delete(messages).run();
          tx.delete(attachmentCache).run();
          tx.delete(conversations).run();
          tx.delete(contacts).run();
          tx.delete(avatarCache).run();
          tx.delete(nostrProfiles).run();
          tx.delete(callHistory).run();
          tx.delete(blockedIdentities).run();
          tx.delete(communicationGrants).run();
          tx.delete(messageRequests).run();
          tx.delete(settings)
            .where(
              notInArray(settings.key, [
                "language",
                "theme",
                "haptics",
                "security.appLock",
                "relay.settings.initialized",
              ]),
            )
            .run();
          setPreference(tx, pinned, pending);
          setPreference(tx, activeSlot, pending);
          setPreference(tx, retiredSlot, oldSlot);
        });
      } catch (error) {
        if (preference(db, pinned) !== previous) throw error;
        return;
      }
    } else {
      db.delete(settings).where(eq(settings.key, pendingSwitch)).run();
    }
  }
  const retired = preference(db, retiredSlot);
  if (retired && retired !== currentSlot(db)) {
    try {
      await storage.remove(retired);
      db.delete(settings).where(eq(settings.key, retiredSlot)).run();
    } catch {
      return;
    }
  }
}

export async function loadPinnedIdentity<TResult>(
  db: IdentityDatabase<TResult>,
  storage: Storage,
  random: () => Promise<Uint8Array>,
) {
  await recoverSwitch(db, storage);
  const pinnedKey = preference(db, pinned);
  const storageKey = currentSlot(db);
  let secret = await storage.read(storageKey);
  const identity = await loadIdentity(
    {
      read: async () => secret,
      write: async (value) => {
        await storage.write(storageKey, value);
        secret = value;
      },
    },
    pinnedKey,
    random,
  );
  if (secret === null) throw new Error("Identity missing from secure storage");
  const fresh = pinnedKey === null;
  if (fresh) setPreference(db, pinned, identity.publicKey);
  return { identity, secret, fresh };
}
