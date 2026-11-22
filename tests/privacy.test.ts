import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { deriveIdentity } from "../src/core/identity/keys";
import { createPrivacy } from "../src/core/privacy";
import * as schema from "../src/db/schema";
import { initializeTestDatabase } from "./db-fixture";

const own = deriveIdentity("01".repeat(32)).publicKey;
const alice = deriveIdentity("02".repeat(32)).publicKey;
const bob = deriveIdentity("03".repeat(32)).publicKey;

test("contacts, direct Welcome approvals and successful initiation are distinct permissions", () => {
  using sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  const privacy = createPrivacy(db, own);
  expect(privacy.canReceiveCall(alice)).toBe(true);
  expect(privacy.messagePermission(alice)).toBe("allow");

  privacy.set("calls", "contacts");
  privacy.set("messages", "contacts");
  expect(privacy.canReceiveCall(alice)).toBe(false);
  expect(privacy.messagePermission(alice)).toBe("reject");
  db.insert(schema.contacts).values({ publicKey: bob, name: "Bob" }).run();
  expect(privacy.canReceiveCall(bob)).toBe(true);
  expect(privacy.messagePermission(bob)).toBe("allow");

  privacy.set("requests", true);
  expect(privacy.messagePermission(alice)).toBe("request");
  privacy.approveInvitation(alice);
  expect(privacy.messagePermission(alice)).toBe("allow");
  expect(privacy.canReceiveCall(alice)).toBe(false);
  privacy.set("messages", "initiated");
  expect(privacy.preferences().requests).toBe(false);
  expect(privacy.messagePermission(alice)).toBe("reject");
  expect(privacy.messagePermission(bob)).toBe("reject");
  privacy.noteInitiatedMessage(alice);
  expect(privacy.messagePermission(alice)).toBe("allow");

  privacy.block(alice);
  const restarted = createPrivacy(db, own);
  expect(restarted.messagePermission(alice)).toBe("blocked");
  expect(restarted.canReceiveCall(alice)).toBe(false);
  restarted.unblock(alice);
  expect(restarted.messagePermission(alice)).toBe("allow");
  restarted.set("messages", "contacts");
  expect(restarted.preferences().requests).toBe(true);
});

test("call initiation grants message permission without changing incoming call policy", () => {
  using sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  const privacy = createPrivacy(db, own);
  privacy.set("calls", "nobody");
  privacy.set("messages", "initiated");
  expect(privacy.messagePermission(bob)).toBe("reject");
  privacy.noteCompletedCall(bob);
  expect(privacy.messagePermission(bob)).toBe("allow");
  expect(privacy.canReceiveCall(bob)).toBe(false);
});
