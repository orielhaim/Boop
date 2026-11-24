import { getPublicKey } from "nostr-tools/pure";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createBlockedUsers } from "../src/core/marmot/blocked-users";
import { createPrivacy } from "../src/core/privacy";
import * as schema from "../src/db/schema";
import { initializeTestDatabase } from "./db-fixture";

const own = getPublicKey(Buffer.from("01".repeat(32), "hex"));
const alice = getPublicKey(Buffer.from("02".repeat(32), "hex"));
const bob = getPublicKey(Buffer.from("03".repeat(32), "hex"));

function fixture(keys: string[] = []) {
  let revision = 0;
  const blocks = createBlockedUsers(own, {
    observe(_owner, receive) {
      receive({ revision: String(revision), keys });
      return () => {};
    },
    async set(_owner, key, blocked) {
      keys = [
        ...keys.filter((item) => item !== key),
        ...(blocked ? [key] : []),
      ];
      return { revision: String(++revision), keys };
    },
  });
  blocks.start();
  return blocks;
}

test("contacts, direct Welcome approvals and successful initiation are distinct permissions", async () => {
  using sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  const privacy = createPrivacy(db, fixture());
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

  await privacy.blocks.block(alice);
  expect(privacy.messagePermission(alice)).toBe("blocked");
  expect(privacy.canReceiveCall(alice)).toBe(false);
  await privacy.blocks.unblock(alice);
  expect(privacy.messagePermission(alice)).toBe("allow");
  privacy.set("messages", "contacts");
  expect(privacy.preferences().requests).toBe(true);
  expect(
    sqlite
      .query("SELECT name FROM pragma_table_info('peer_permissions')")
      .values(),
  ).toEqual([["public_key"], ["initiated"], ["approved"]]);
});

test("call initiation grants message permission without changing incoming call policy", () => {
  using sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  const privacy = createPrivacy(db, fixture());
  privacy.set("calls", "nobody");
  privacy.set("messages", "initiated");
  expect(privacy.messagePermission(bob)).toBe("reject");
  privacy.noteCompletedCall(bob);
  expect(privacy.messagePermission(bob)).toBe("allow");
  expect(privacy.canReceiveCall(bob)).toBe(false);
});
