import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { deriveIdentity } from "../src/core/identity/keys";
import { createPrivacy } from "../src/core/privacy";
import {
  createMessagingRepository,
  type MessageInput,
} from "../src/db/messaging";
import migrations from "../src/db/migrations/bundle";
import * as schema from "../src/db/schema";

const own = deriveIdentity("01".repeat(32)).publicKey;
const alice = deriveIdentity("02".repeat(32)).publicKey;
const bob = deriveIdentity("03".repeat(32)).publicKey;

function prepare(sqlite: Database) {
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of Object.values(migrations.migrations))
    sqlite.exec(migration);
  const db = drizzle(sqlite, { schema });
  const chat = createMessagingRepository(db);
  return { db, chat, privacy: createPrivacy(db, chat, own) };
}

function incoming(
  peerKey: string,
  id: string,
  sentAt = Date.now(),
): MessageInput {
  return {
    peerKey,
    id,
    eventId: id,
    sentAt,
    body: "Hello",
    direction: "incoming",
    senderKey: peerKey,
    recipientKey: own,
    replyTo: null,
  };
}

test("contacts, delivery grants and request approvals are distinct permissions", () => {
  using sqlite = new Database(":memory:");
  const { db, chat, privacy } = prepare(sqlite);
  expect(privacy.canReceiveCall(alice)).toBe(true);
  expect(privacy.messagePermission(alice)).toBe("allow");
  privacy.set("calls", "contacts");
  privacy.set("messages", "contacts");
  expect(privacy.canReceiveCall(alice)).toBe(false);
  expect(privacy.messagePermission(alice)).toBe("reject");
  db.insert(schema.contacts).values({ publicKey: bob, name: "Bob" }).run();
  expect(privacy.canReceiveCall(bob)).toBe(true);
  expect(privacy.messagePermission(bob)).toBe("allow");
  privacy.set("calls", "nobody");
  expect(privacy.canReceiveCall(bob)).toBe(false);
  privacy.set("requests", true);
  expect(privacy.messagePermission(alice)).toBe("request");
  const first = incoming(alice, "alpha", 1);
  db.insert(schema.messageRequests)
    .values({ publicKey: alice, receivedAt: 1, message: first })
    .run();
  const second = incoming(alice, "beta", 2);
  privacy.queue(second);
  privacy.queue({ ...second, id: "duplicate" });
  expect(privacy.request(alice).map((message) => message.id)).toEqual([
    "alpha",
    "beta",
  ]);
  expect(chat.unreadCount()).toBe(0);
  expect(privacy.accept(alice)).toBe(true);
  expect(privacy.pendingCount()).toBe(0);
  expect(chat.history(alice).messages.map((message) => message.id)).toEqual([
    "alpha",
    "beta",
  ]);
  expect(chat.unreadCount()).toBe(2);
  expect(privacy.messagePermission(alice)).toBe("allow");
  expect(privacy.canReceiveCall(alice)).toBe(false);
  privacy.set("messages", "initiated");
  expect(privacy.preferences().requests).toBe(false);
  privacy.set("requests", false);
  privacy.set("messages", "contacts");
  expect(privacy.preferences().requests).toBe(true);
  privacy.set("messages", "initiated");
  expect(privacy.messagePermission(alice)).toBe("reject");
  expect(privacy.messagePermission(bob)).toBe("reject");
  const outgoing = {
    ...incoming(alice, "sent"),
    direction: "outgoing" as const,
    senderKey: own,
    recipientKey: alice,
  };
  chat.receive({ ...outgoing, id: "external", eventId: "external" });
  expect(privacy.messagePermission(alice)).toBe("reject");
  chat.enqueue(outgoing);
  expect(privacy.messagePermission(alice)).toBe("reject");
  chat.setStatus("sent", "sent");
  expect(privacy.messagePermission(alice)).toBe("allow");
  privacy.block(alice);
  expect(privacy.messagePermission(alice)).toBe("blocked");
  expect(chat.unreadCount()).toBe(0);
  expect(chat.history(alice).messages).toHaveLength(4);
});

test("bounds pending requests, retains them on restart, and honors existing decline cutoffs", () => {
  using sqlite = new Database(":memory:");
  const { db, chat, privacy } = prepare(sqlite);
  privacy.set("requests", true);
  const first = incoming(alice, "first");
  db.insert(schema.messageRequests)
    .values({
      publicKey: alice,
      receivedAt: first.sentAt,
      declinedThrough: first.sentAt - 1,
    })
    .run();
  privacy.queue(incoming(alice, "old", first.sentAt - 1));
  privacy.queue(first);
  for (let index = 0; index < 1_000; index++)
    privacy.queue(incoming(alice, `flood-${index}`));
  privacy.queue(incoming(bob, "another"));
  const restarted = createPrivacy(db, chat, own);
  expect(restarted.pendingCount()).toBe(2);
  expect(restarted.request(alice)).toHaveLength(16);
  expect(restarted.request(alice).some(({ id }) => id === "first")).toBe(true);
  expect(restarted.request(alice).some(({ id }) => id === "old")).toBe(false);
  restarted.block(alice);
  expect(restarted.pendingCount()).toBe(1);
  restarted.set("messages", "initiated");
  expect(restarted.accept(bob)).toBe(false);
  restarted.block(bob);
  expect(restarted.pendingCount()).toBe(0);
  expect(chat.unreadCount()).toBe(0);
  expect(createPrivacy(db, chat, own).isBlocked(bob)).toBe(true);
});
