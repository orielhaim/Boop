import { eq, notInArray } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { preference, setPreference } from "@/db/queries";
import type * as schema from "@/db/schema";
import {
  avatarCache,
  nostrProfiles,
  callHistory,
  peerPermissions,
  contacts,
  linkPreviewCache,
  settings,
  speechJobs,
  downloads,
} from "@/db/schema";
import { inboxIntentKey } from "../nostr/config";
import { deriveIdentity, parsePublicKey } from "./keys";
import { speechKeySlot } from "../speech/types";

const key = "boop.identity.v1";
const pinned = "identity.publicKey";
const activeSlot = "identity.activeSlot";
const pendingSwitch = "identity.pendingSwitch";
const retiredSlot = "identity.retiredSlot";
const retiredSpeech = "identity.retiredSpeech";
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

export function isPinnedIdentity<TResult>(
  db: IdentityDatabase<TResult>,
  publicKey: string,
) {
  return preference(db, pinned) === publicKey;
}

const slot = (publicKey: string) => `${key}.${publicKey}`;
const currentSlot = <TResult>(db: IdentityDatabase<TResult>) => {
  const saved = preference(db, activeSlot);
  if (saved === null) return key;
  if (saved !== preference(db, pinned) || parsePublicKey(saved) !== saved)
    throw new IdentityMismatchError();
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
      throw new IdentityMismatchError();
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
          tx.delete(linkPreviewCache).run();
          tx.delete(contacts).run();
          tx.delete(avatarCache).run();
          tx.delete(nostrProfiles).run();
          tx.delete(callHistory).run();
          tx.delete(peerPermissions).run();
          tx.delete(speechJobs).run();
          tx.delete(downloads).run();
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
          setPreference(tx, retiredSpeech, speechKeySlot(previous));
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
      const speech = preference(db, retiredSpeech);
      if (speech) await storage.remove(speech);
      db.delete(settings).where(eq(settings.key, retiredSlot)).run();
      db.delete(settings).where(eq(settings.key, retiredSpeech)).run();
    } catch {
      return;
    }
  }
}

export async function findPinnedIdentity<TResult>(
  db: IdentityDatabase<TResult>,
  storage: Storage,
) {
  await recoverSwitch(db, storage);
  const pinnedKey = preference(db, pinned);
  const secret = await storage.read(currentSlot(db));
  if (secret === null && pinnedKey === null) return null;
  if (secret === null) throw new IdentityMismatchError();
  let identity;
  try {
    identity = deriveIdentity(secret);
  } catch {
    throw new IdentityMismatchError();
  }
  if (pinnedKey !== null && pinnedKey !== identity.publicKey)
    throw new IdentityMismatchError();
  if (pinnedKey === null) {
    db.transaction((tx) => {
      setPreference(tx, pinned, identity.publicKey);
      const draftOwner = preference(tx, "profile.initialBackup");
      if (draftOwner === identity.publicKey)
        setPreference(tx, inboxIntentKey, "initial");
      else if (draftOwner) {
        setPreference(tx, "profile.draft", "");
        setPreference(tx, "profile.initialBackup", "");
      }
    });
  }
  return { identity, secret, fresh: pinnedKey === null };
}

export class IdentityMismatchError extends Error {
  constructor() {
    super("Identity mismatch");
  }
}

export async function installFirstIdentity<TResult>(
  db: IdentityDatabase<TResult>,
  storage: Storage,
  secret: string,
  draft: string,
) {
  if (await findPinnedIdentity(db, storage))
    throw new Error("Identity already exists");
  const identity = deriveIdentity(secret);
  db.transaction((tx) => {
    setPreference(tx, "profile.draft", draft);
    setPreference(tx, "profile.initialBackup", draft ? identity.publicKey : "");
  });
  await storage.write(key, secret);
  if ((await storage.read(key)) !== secret) throw new IdentityMismatchError();
  db.transaction((tx) => {
    setPreference(tx, pinned, identity.publicKey);
    if (draft) setPreference(tx, inboxIntentKey, "initial");
  });
}
