import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { toDetailMessage } from "../src/components/messages/detail-adapter";
import { createHistoryLoader } from "../src/core/messaging/history";
import {
  canShowGreeting,
  externalMessageUrl,
  sendEmptyGreeting,
} from "../src/core/messaging/message-links";
import { createRelayService } from "../src/core/nostr/relay-service";
import { createMessagingService } from "../src/core/messaging/runtime";
import {
  createMessagingRepository,
  type MessageInput,
} from "../src/db/messaging";
import { initializeTestDatabase } from "./db-fixture";
import * as schema from "../src/db/schema";
import { resources } from "../src/i18n/resources";

const signer = new NDKPrivateKeySigner("01".repeat(32));
const own = signer.pubkey;
const peer = new NDKPrivateKeySigner("02".repeat(32)).pubkey;
const participants = { self: { _id: own }, peer: { _id: peer } };

function createChat(sqlite: Database) {
  initializeTestDatabase(sqlite);
  return createMessagingRepository(drizzle(sqlite, { schema }));
}

function message(n: number): MessageInput {
  return {
    id: `local-${n}`,
    eventId: `rumor-${n}`,
    body: `Message ${n}`,
    direction: "incoming",
    peerKey: peer,
    senderKey: peer,
    recipientKey: own,
    sentAt: n + 1,
    replyTo: null,
  };
}

test("pins multiple messages by canonical reference, reopens them and keeps pins local", () => {
  using sqlite = new Database(":memory:");
  using otherSqlite = new Database(":memory:");
  const chat = createChat(sqlite);
  const recipient = createChat(otherSqlite);
  recipient.receive({ ...message(0), peerKey: own, direction: "outgoing" });
  for (let n = 0; n < 80; n++) chat.receive(message(n));
  const changes: unknown[] = [];
  chat.subscribe((change) => changes.push(change));
  chat.toggleMessagePin(peer, "rumor-0");
  chat.toggleMessagePin(peer, "local-78");
  chat.toggleMessagePin(own, "rumor-0");
  expect(changes).toEqual([{ history: [peer] }, { history: [peer] }]);
  expect(chat.pending()).toEqual([]);
  expect(recipient.pinnedMessages(own)).toEqual([]);
  expect(chat.message(peer, "local-0")?.body).toBe("Message 0");

  using reopened = Database.deserialize(sqlite.serialize());
  const restored = createMessagingRepository(drizzle(reopened, { schema }));
  const pins = restored.pinnedMessages(peer);
  expect(pins.map(({ id }) => id).sort()).toEqual(["local-0", "local-78"]);
  const old = pins.find(({ id }) => id === "local-0");
  if (!old) throw new Error("Expected a persisted pin");
  const history = createHistoryLoader(restored);
  try {
    expect(
      history.recent(peer).page.messages.some(({ id }) => id === old.id),
    ).toBe(false);
    const { start, limit } = history.around(peer, old);
    const page = history.read(peer, { atOrAfter: start, limit });
    const jumped = page.messages.find(({ id }) => id === old.id);
    if (!jumped) throw new Error("Expected the pin's history page");
    expect(toDetailMessage(jumped, undefined, participants, "").isPinned).toBe(
      true,
    );

    restored.toggleMessagePin(peer, "local-78");
    restored.deleteMessages(peer, [old.id]);
    expect(restored.pinnedMessages(peer)).toEqual([]);
    restored.toggleMessagePin(peer, old.id);
    expect(restored.pinnedMessages(peer)).toEqual([]);
    restored.toggleMessagePin(peer, "local-17");
    restored.deleteConversations([peer]);
    expect(restored.pinnedMessages(peer)).toEqual([]);
  } finally {
    history.dispose();
  }
});

test("the empty-chat wave uses the real encrypted outbox entry point and stops after history exists", async () => {
  using sqlite = new Database(":memory:");
  const chat = createChat(sqlite);
  const relays = createRelayService({
    signer,
    readState: () => null,
    writeState: () => {},
  });
  const runtime = createMessagingService({
    relays,
    signer,
    chat,
    readState: () => null,
    writeState: () => {},
    createId: () => crypto.randomUUID(),
  });
  expect(runtime.getHistoryReady()).toBe(false);
  runtime.start();
  relays.start({ general: [], discovery: [], inbox: [], intent: null });
  expect(runtime.getHistoryReady()).toBe(true);
  const empty = {
    hasHistory: false,
    historyReady: true,
    blocked: false,
    pending: false,
  };
  const send = (body: string) =>
    runtime.send({ peerKey: peer, body, replyTo: null });
  for (const state of [
    { ...empty, hasHistory: true },
    { ...empty, historyReady: false },
    { ...empty, blocked: true },
    { ...empty, pending: true },
  ]) {
    expect(canShowGreeting(state)).toBe(false);
    expect(sendEmptyGreeting(state, send)).toBeUndefined();
  }
  expect(chat.pending()).toEqual([]);
  expect(canShowGreeting(empty)).toBe(true);
  const id = await sendEmptyGreeting(empty, send);
  expect(chat.pending()).toMatchObject([{ id, body: "👋", peerKey: peer }]);
  expect(
    sendEmptyGreeting({ ...empty, hasHistory: chat.hasMessages(peer) }, send),
  ).toBeUndefined();
  expect(resources.en.chatKit.labels.emptyChatTitle).toBe("Say hello");
  expect(resources.he.chatKit.labels.emptyChatTitle).toBe("אפשר להגיד שלום");
  runtime.stop();
  relays.stop();
  expect(runtime.getHistoryReady()).toBe(false);
});

test("safe message-link actions use only the schemes expected by Chat Kit", () => {
  expect(externalMessageUrl("mailto:oriel+chat@example.org", "email")).toBe(
    "mailto:oriel%2Bchat@example.org",
  );
  expect(externalMessageUrl("tel:+972501234567", "phone")).toBe(
    "tel:+972501234567",
  );
  expect(externalMessageUrl("tel:00442079460000", "phone")).toBe(
    "tel:+442079460000",
  );
  expect(externalMessageUrl("tel:0501234567", "phone")).toBe("tel:0501234567");
  expect(
    externalMessageUrl("https://example.org/1234567?lang=עברית", "url"),
  ).toBe("https://example.org/1234567?lang=%D7%A2%D7%91%D7%A8%D7%99%D7%AA");
  for (const [value, type] of [
    ["mailto:person@example.org?bcc=other@example.org", "email"],
    ["tel:20261121", "phone"],
    ["tel:1795278735472", "phone"],
    ["tel:1234", "phone"],
    ["tel:*123%23", "phone"],
    ["nostr:npub1...", "phone"],
    ["javascript:alert(1)", "url"],
    ["intent://app/", "url"],
    ["https://user:pass@example.org/", "url"],
    ["tel:0501234567", "email"],
  ])
    expect(externalMessageUrl(value, type)).toBeUndefined();
});
