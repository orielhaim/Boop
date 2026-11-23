import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { deriveIdentity } from "../src/core/identity/keys";
import {
  findPinnedIdentity,
  installFirstIdentity,
  stageSwitch,
} from "../src/core/identity/storage";
import { initializeTestDatabase } from "./db-fixture";
import { preference, setPreference } from "../src/db/queries";
import * as schema from "../src/db/schema";
import { speechKeySlot } from "../src/core/speech/types";

const previousSecret = "01".repeat(32);
const nextSecret = "02".repeat(32);
const previousKey = deriveIdentity(previousSecret).publicKey;
const nextKey = deriveIdentity(nextSecret).publicKey;
const originalSlot = "boop.identity.v1";
const newSlot = `${originalSlot}.${nextKey}`;
function setup(sqlite: Database) {
  initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  const keys = new Map([[originalSlot, previousSecret]]);
  const storage = {
    read: async (slot: string) => keys.get(slot) ?? null,
    write: async (slot: string, secret: string) => {
      keys.set(slot, secret);
    },
    remove: async (slot: string) => {
      keys.delete(slot);
    },
  };
  setPreference(db, "identity.publicKey", previousKey);
  setPreference(db, "security.appLock", "0");
  db.insert(schema.contacts)
    .values({ publicKey: nextKey, name: "Old contact" })
    .run();
  db.insert(schema.peerPermissions)
    .values({ publicKey: nextKey, blockedAt: 1 })
    .run();
  setPreference(db, "marmot.pins.old", "old-message");
  return { db, keys, storage };
}

test("same-identity import keeps records and a staged replacement only activates on startup", async () => {
  using sqlite = new Database(":memory:");
  const { db, keys, storage } = setup(sqlite);
  keys.set(speechKeySlot(previousKey), "test-cache-key");
  db.insert(schema.speechJobs)
    .values({
      id: "old-job",
      account: previousKey,
      attachment: "slot",
      job: "{}",
      sealed: "ciphertext",
    })
    .run();
  expect(await stageSwitch(db, storage, previousSecret)).toBe("same");
  expect(db.select().from(schema.contacts).all()).toHaveLength(1);
  expect(await stageSwitch(db, storage, nextSecret)).toBe("staged");
  expect(preference(db, "identity.publicKey")).toBe(previousKey);
  expect(keys.has(originalSlot)).toBe(true);
  const active = await findPinnedIdentity(db, storage);
  expect(active?.identity.publicKey).toBe(nextKey);
  expect(keys.has(originalSlot)).toBe(false);
  expect(keys.has(speechKeySlot(previousKey))).toBe(false);
  expect(db.select().from(schema.speechJobs).all()).toEqual([]);
  expect(db.select().from(schema.contacts).all()).toEqual([]);
  expect(db.select().from(schema.peerPermissions).all()).toEqual([]);
  expect(preference(db, "marmot.pins.old")).toBeNull();
  expect(preference(db, "security.appLock")).toBe("0");
  expect((await findPinnedIdentity(db, storage))?.identity.publicKey).toBe(
    nextKey,
  );
});

test("a lost staged slot or failed SQLite reset preserves the previous identity and data", async () => {
  using sqlite = new Database(":memory:");
  const { db, keys, storage } = setup(sqlite);
  await stageSwitch(db, storage, nextSecret);
  keys.delete(newSlot);
  expect((await findPinnedIdentity(db, storage))?.identity.publicKey).toBe(
    previousKey,
  );
  expect(db.select().from(schema.contacts).all()).toHaveLength(1);
  const brokenStore = {
    ...storage,
    write: async () => {
      throw new Error("Storage failure");
    },
  };
  await expect(stageSwitch(db, brokenStore, nextSecret)).rejects.toThrow(
    "Storage failure",
  );
  await stageSwitch(db, storage, nextSecret);
  sqlite.exec(
    "CREATE TRIGGER stop_reset BEFORE DELETE ON contacts BEGIN SELECT RAISE(ABORT, 'reset interrupted'); END",
  );
  expect((await findPinnedIdentity(db, storage))?.identity.publicKey).toBe(
    previousKey,
  );
  expect(preference(db, "marmot.pins.old")).toBe("old-message");
  expect(keys.has(originalSlot)).toBe(true);
  sqlite.exec("DROP TRIGGER stop_reset");
  expect((await findPinnedIdentity(db, storage))?.identity.publicKey).toBe(
    nextKey,
  );
});

test("first launch reads secure storage without generating or pinning a key", async () => {
  using sqlite = new Database(":memory:");
  const { db, storage, keys } = setup(sqlite);
  db.delete(schema.settings).run();
  keys.clear();
  expect(await findPinnedIdentity(db, storage)).toBeNull();
  expect(preference(db, "identity.publicKey")).toBeNull();
  expect(keys.size).toBe(0);
});

test("explicit setup retains its private key and pending public draft across boot", async () => {
  using sqlite = new Database(":memory:");
  const { db, storage, keys } = setup(sqlite);
  db.delete(schema.settings).run();
  keys.clear();
  const profile = JSON.stringify({
    name: "Alex",
    photo: { kind: "unchanged" },
  });
  await installFirstIdentity(db, storage, nextSecret, profile);
  expect((await findPinnedIdentity(db, storage))?.identity.publicKey).toBe(
    nextKey,
  );
  expect(preference(db, "profile.draft")).toBe(profile);
  await expect(
    installFirstIdentity(db, storage, previousSecret, ""),
  ).rejects.toThrow("already exists");
  expect(keys.get(originalSlot)).toBe(nextSecret);
});

test("a key persisted before a startup interruption is recovered without replacement", async () => {
  using sqlite = new Database(":memory:");
  const { db, storage, keys } = setup(sqlite);
  db.delete(schema.settings).run();
  keys.clear();
  const interrupted = {
    ...storage,
    async write(slot: string, secret: string) {
      await storage.write(slot, secret);
      throw new Error("Interrupted");
    },
  };
  await expect(
    installFirstIdentity(db, interrupted, nextSecret, "{}"),
  ).rejects.toThrow("Interrupted");
  expect(preference(db, "identity.publicKey")).toBeNull();
  expect((await findPinnedIdentity(db, storage))?.identity.publicKey).toBe(
    nextKey,
  );
  expect(preference(db, "profile.draft")).toBe("{}");
});

test("missing, corrupt, and mismatched SecureStore values fail closed", async () => {
  using sqlite = new Database(":memory:");
  const { db, keys, storage } = setup(sqlite);
  for (const value of [undefined, "bad", nextSecret]) {
    if (value) keys.set(originalSlot, value);
    else keys.delete(originalSlot);
    await expect(findPinnedIdentity(db, storage)).rejects.toThrow(
      "Identity mismatch",
    );
    expect(preference(db, "identity.publicKey")).toBe(previousKey);
    expect(keys.get(originalSlot)).toBe(value);
  }
  await expect(
    findPinnedIdentity(db, {
      ...storage,
      read: async () => {
        throw new Error("locked");
      },
    }),
  ).rejects.toThrow("locked");
});
