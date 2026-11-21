import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { deriveIdentity } from "../src/core/identity/keys";
import { loadPinnedIdentity, stageSwitch } from "../src/core/identity/storage";
import { initializeTestDatabase } from "./db-fixture";
import { preference, setPreference } from "../src/db/queries";
import * as schema from "../src/db/schema";

const previousSecret = "01".repeat(32);
const nextSecret = "02".repeat(32);
const previousKey = deriveIdentity(previousSecret).publicKey;
const nextKey = deriveIdentity(nextSecret).publicKey;
const originalSlot = "boop.identity.v1";
const newSlot = `${originalSlot}.${nextKey}`;
const noRandom = async (): Promise<Uint8Array> => {
  throw new Error("Unexpected key generation");
};

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
  db.insert(schema.conversations)
    .values({ peerKey: nextKey, updatedAt: 1, draft: "Old draft" })
    .run();
  return { db, keys, storage };
}

test("same-identity import keeps records and a staged replacement only activates on startup", async () => {
  using sqlite = new Database(":memory:");
  const { db, keys, storage } = setup(sqlite);
  expect(await stageSwitch(db, storage, previousSecret)).toBe("same");
  expect(db.select().from(schema.contacts).all()).toHaveLength(1);
  expect(await stageSwitch(db, storage, nextSecret)).toBe("staged");
  expect(preference(db, "identity.publicKey")).toBe(previousKey);
  expect(keys.has(originalSlot)).toBe(true);
  const active = await loadPinnedIdentity(db, storage, noRandom);
  expect(active.identity.publicKey).toBe(nextKey);
  expect(keys.has(originalSlot)).toBe(false);
  expect(db.select().from(schema.contacts).all()).toEqual([]);
  expect(db.select().from(schema.peerPermissions).all()).toEqual([]);
  expect(db.select().from(schema.conversations).all()).toEqual([]);
  expect(preference(db, "security.appLock")).toBe("0");
  expect(
    (await loadPinnedIdentity(db, storage, noRandom)).identity.publicKey,
  ).toBe(nextKey);
});

test("a lost staged slot or failed SQLite reset preserves the previous identity and data", async () => {
  using sqlite = new Database(":memory:");
  const { db, keys, storage } = setup(sqlite);
  await stageSwitch(db, storage, nextSecret);
  keys.delete(newSlot);
  expect(
    (await loadPinnedIdentity(db, storage, noRandom)).identity.publicKey,
  ).toBe(previousKey);
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
  expect(
    (await loadPinnedIdentity(db, storage, noRandom)).identity.publicKey,
  ).toBe(previousKey);
  expect(db.select().from(schema.conversations).all()).toHaveLength(1);
  expect(keys.has(originalSlot)).toBe(true);
  sqlite.exec("DROP TRIGGER stop_reset");
  expect(
    (await loadPinnedIdentity(db, storage, noRandom)).identity.publicKey,
  ).toBe(nextKey);
});
