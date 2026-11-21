import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { seedStressConversations, stressArrival } from "./chat-fixture";
import {
  createMessagingRepository,
  type MessageInput,
} from "../src/db/messaging";
import { initializeTestDatabase } from "./db-fixture";
import * as schema from "../src/db/schema";

const own = "own";
const alice = "alice";
const bob = "bob";

function migrated(sqlite: Database) {
  initializeTestDatabase(sqlite);
  return createMessagingRepository(drizzle(sqlite, { schema }));
}

function incoming(id: string, sentAt = 100, peerKey = alice): MessageInput {
  return {
    id,
    eventId: `rumor-${id}`,
    peerKey,
    direction: "incoming",
    body: `Hello, ${id}`,
    sentAt,
    replyTo: null,
    senderKey: peerKey,
    recipientKey: own,
  };
}

test("keeps the optimistic message ID and relay status across a sender-copy sync and restart", () => {
  using sqlite = new Database(":memory:");
  const repo = migrated(sqlite);
  const draft = "Heading out";
  const outgoing: MessageInput = {
    ...incoming("stable-local-id"),
    body: draft,
    direction: "outgoing",
    eventId: "canonical-rumor-id",
    senderKey: own,
    recipientKey: alice,
    rumorJson: '{"content":"Heading out"}',
  };
  const savedDraft = "Another message";
  repo.saveDraft(alice, draft, null);
  expect(repo.enqueue(outgoing)).toBe(true);
  expect(repo.conversation(alice)).toMatchObject({
    draft: "",
    preview: draft,
    lastMessageDirection: "outgoing",
    lastMessageStatus: "pending",
  });

  repo.saveDraft(alice, savedDraft, null);
  expect(repo.enqueue(outgoing)).toBe(false);
  expect(repo.conversation(alice)?.draft).toBe(savedDraft);

  const reopened = createMessagingRepository(drizzle(sqlite, { schema }));
  expect(reopened.pending()).toMatchObject([
    { id: outgoing.id, rumorJson: outgoing.rumorJson },
  ]);
  expect(reopened.receive({ ...outgoing, id: "synced-copy" })).toBe(false);
  expect(reopened.message(alice, "canonical-rumor-id")).toMatchObject({
    id: outgoing.id,
    status: "pending",
  });
  expect(reopened.setStatus(outgoing.id, "failed", "no-relay-accepted")).toBe(
    true,
  );
  expect(reopened.pending()).toEqual([]);
  expect(reopened.setStatus(outgoing.id, "pending")).toBe(true);
  expect(reopened.setStatus(outgoing.id, "sent")).toBe(true);
  expect(reopened.setStatus(outgoing.id, "failed", "late-failure")).toBe(false);
  expect(reopened.history(alice).messages).toMatchObject([
    { id: outgoing.id, status: "sent", failure: null },
  ]);
  expect(
    sqlite
      .query("SELECT rumor_json FROM messages WHERE id = ?")
      .values(outgoing.id),
  ).toEqual([[null]]);
  expect(reopened.conversation(alice)?.draft).toBe(savedDraft);
});

test("keyset history orders equal timestamps by ID and pages in either direction", () => {
  using sqlite = new Database(":memory:");
  const repo = migrated(sqlite);
  repo.receive(incoming("c"));
  repo.receive(incoming("a"));
  repo.receive(incoming("e", 200));
  repo.receive(incoming("b"));
  repo.receive(incoming("d"));
  const latest = repo.history(alice, { limit: 2 });
  expect(latest.messages.map(({ id }) => id)).toEqual(["d", "e"]);
  if (!latest.older) throw new Error("Expected older cursor");
  const previous = repo.history(alice, { before: latest.older, limit: 2 });
  expect(previous.messages.map(({ id }) => id)).toEqual(["b", "c"]);
  if (!previous.newer) throw new Error("Expected newer cursor");
  expect(
    repo
      .history(alice, { after: previous.newer, limit: 2 })
      .messages.map(({ id }) => id),
  ).toEqual(["d", "e"]);
  expect(
    repo
      .history(alice, { atOrAfter: latest.older, limit: 2 })
      .messages.map(({ id }) => id),
  ).toEqual(["d", "e"]);
  expect(
    repo
      .history(alice, { atOrBefore: previous.older ?? latest.older, limit: 2 })
      .messages.map(({ id }) => id),
  ).toEqual(["a", "b"]);
});

test("counts unique inbound messages and reads only the presented IDs", () => {
  using sqlite = new Database(":memory:");
  const repo = migrated(sqlite);
  repo.receive(incoming("a", 100));
  repo.receive(incoming("b", 100));
  repo.receive(incoming("other", 50, bob));
  repo.receive({ ...incoming("a", 100), id: "different-wrap" });
  const current = createMessagingRepository(drizzle(sqlite, { schema }));
  expect(current.conversation(alice)?.unread).toBe(2);
  expect(current.firstUnread(alice)?.id).toBe("a");
  current.markRead(alice, ["b", "b", "other"]);
  current.receive(incoming("late", 10));
  expect(current.conversation(alice)?.unread).toBe(2);
  expect(current.firstUnread(alice)?.id).toBe("late");
  expect(current.unreadCount()).toBe(3);
  current.deleteMessages(alice, ["a", "late"]);
  expect(current.conversation(alice)?.unread).toBe(0);
  expect(current.firstUnread(alice)).toBeUndefined();
  expect(current.unreadCount()).toBe(1);
});

test("resolves replies by rumor or local ID and remembers local reaction removal", () => {
  using sqlite = new Database(":memory:");
  const repo = migrated(sqlite);
  const target = incoming("target");
  const reaction = {
    peerKey: alice,
    targetEventId: "rumor-target",
    author: alice,
    emoji: "👍",
    eventId: "reaction",
  };
  expect(repo.receiveReaction(reaction)).toBe(true);
  expect(repo.conversations()).toEqual([]);
  repo.receive({ ...incoming("reply", 200), replyTo: "rumor-target" });
  expect(repo.refs(alice, ["rumor-target"]).size).toBe(0);
  repo.receive(target);
  expect(
    repo.refs(alice, ["target", "rumor-target"]).get("rumor-target")?.id,
  ).toBe("target");
  expect(repo.message(alice, "target")?.reactions).toEqual([
    { author: alice, emoji: "👍" },
  ]);
  expect(repo.toggleReaction(alice, "rumor-target", own, "❤️")).toBe(true);
  expect(repo.toggleReaction(alice, "target", own, "❤️")).toBe(false);
  expect(
    repo.receiveReaction({
      ...reaction,
      author: own,
      emoji: "❤️",
      eventId: "own-reaction",
    }),
  ).toBe(false);
  expect(repo.receiveReaction({ ...reaction, eventId: "different-wrap" })).toBe(
    false,
  );
  expect(repo.message(alice, "target")?.reactions).toEqual([
    { author: alice, emoji: "👍" },
  ]);
  repo.deleteMessages(alice, ["target"]);
  expect(repo.message(alice, "rumor-target")).toBeUndefined();
  expect(repo.receive(target)).toBe(false);
  expect(repo.receiveReaction(reaction)).toBe(false);
  expect(repo.message(alice, "reply")?.replyTo).toBe("rumor-target");
});

test("keeps pinned and archived conversations stable and deletes history locally", () => {
  using sqlite = new Database(":memory:");
  const repo = migrated(sqlite);
  const message = incoming("alice-first", 100);
  repo.receive(message);
  repo.receive(incoming("bob-first", 200, bob));
  expect(repo.conversations().map(({ peerKey }) => peerKey)).toEqual([
    bob,
    alice,
  ]);
  repo.updateConversations([alice, bob], { pinned: true });
  expect(repo.conversations().map(({ peerKey }) => peerKey)).toEqual([
    alice,
    bob,
  ]);
  repo.reorderPinned([bob, alice]);
  expect(repo.conversations().map(({ peerKey }) => peerKey)).toEqual([
    bob,
    alice,
  ]);
  repo.updateConversations([bob], { archived: true, muted: true });
  repo.receive(incoming("bob-second", 300, bob));
  expect(
    repo.conversations({ archived: false }).map(({ peerKey }) => peerKey),
  ).toEqual([alice]);
  expect(repo.conversations({ archived: true })).toMatchObject([
    { peerKey: bob, muted: true, preview: "Hello, bob-second" },
  ]);
  expect(repo.history(bob).messages).toHaveLength(2);
  repo.deleteConversations([alice]);
  expect(repo.conversation(alice)).toBeUndefined();
  expect(repo.receive(message)).toBe(false);
  expect(repo.history(alice).messages).toEqual([]);
  expect(
    sqlite
      .query("select body, event_id from messages where id = ?")
      .get(message.id),
  ).toEqual({ body: "", event_id: "rumor-alice-first" });
  repo.receive(incoming("alice-new", 400));
  expect(repo.conversations({ archived: false })).toMatchObject([
    { peerKey: alice, unread: 1 },
  ]);
  expect(repo.history(alice).messages).toHaveLength(1);
});

test("10,000-row fixture loads bounded pages and keeps a newer arrival outside an older cursor", () => {
  using sqlite = new Database(":memory:");
  const repo = migrated(sqlite);
  const db = drizzle(sqlite, { schema });
  const { peerKey, secondPeerKey } = seedStressConversations(db, own);
  expect(
    sqlite
      .query("select count(*) as count from messages where peer_key = ?")
      .get(peerKey),
  ).toEqual({ count: 10_000 });
  const latest = repo.history(peerKey);
  const initial = latest.messages.at(-1);
  expect(latest.messages).toHaveLength(50);
  expect(latest.messages.some(({ reactions }) => reactions.length > 0)).toBe(
    true,
  );
  expect(repo.history(secondPeerKey).messages).toHaveLength(24);
  if (!latest.older || !initial?.replyTo)
    throw new Error("Missing fixture pagination and reply");
  const quote = repo.message(peerKey, initial.replyTo);
  if (!quote) throw new Error("Missing fixture quote");
  expect(repo.history(peerKey, { atOrBefore: quote }).messages.at(-1)?.id).toBe(
    quote.id,
  );
  const older = repo.history(peerKey, { before: latest.older });
  const arrival = stressArrival(own, initial.sentAt + 1);
  repo.receive(arrival);
  expect(repo.history(peerKey, { before: latest.older })).toMatchObject({
    messages: older.messages,
  });
  expect(repo.history(peerKey).messages.at(-1)?.id).toBe(arrival.id);
});
