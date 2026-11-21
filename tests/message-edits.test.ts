import { createPrivacy } from "../src/core/privacy";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import NDK, { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toDetailMessage } from "../src/components/messages/detail-adapter";
import { authorizePreview } from "../src/core/messaging/link-previews";
import {
  createRumor,
  giftWrapKind,
  maxMessageLength,
  messageEditKind,
  parseEditRumor,
  parseRumor,
  unwrapPrivateEvent,
  wrapRumor,
} from "../src/core/messaging/nip17";
import {
  createMessagingRepository,
  type MessageInput,
} from "../src/db/messaging";
import { initializeTestDatabase } from "./db-fixture";
import * as schema from "../src/db/schema";

const ndk = new NDK({ enableOutboxModel: false });
const alice = new NDKPrivateKeySigner("01".repeat(32));
const bob = new NDKPrivateKeySigner("02".repeat(32));
const charlie = new NDKPrivateKeySigner("03".repeat(32));
const targetId = "a1".repeat(32);
const otherId = "b2".repeat(32);
const time = 1_724_000_010;

function original(): MessageInput {
  return {
    id: "original-local",
    eventId: targetId,
    body: "Original",
    sentAt: time * 1_000,
    peerKey: alice.pubkey,
    direction: "incoming",
    senderKey: alice.pubkey,
    recipientKey: bob.pubkey,
    replyTo: null,
  };
}

function rumor(
  text: string,
  previousRevisionId = targetId,
  options: {
    author?: string;
    recipient?: string;
    target?: string;
    at?: number;
  } = {},
) {
  const {
    author = alice.pubkey,
    recipient = bob.pubkey,
    target = targetId,
    at = time,
  } = options;
  return createRumor({
    kind: messageEditKind,
    pubkey: author,
    created_at: at,
    tags: [
      ["p", recipient],
      ["e", target],
    ],
    content: JSON.stringify({
      v: 1,
      targetId: target,
      previousRevisionId,
      text,
    }),
  });
}

function edit(value: ReturnType<typeof rumor>, owner = bob.pubkey) {
  const parsed = parseEditRumor(value, owner);
  if (!parsed) throw new Error("Invalid test edit");
  return parsed;
}

function database(sqlite: Database) {
  initializeTestDatabase(sqlite);
  return drizzle(sqlite, { schema });
}

test("reopens a durable revision chain and rolls back a partial apply", () => {
  const directory = mkdtempSync(join(tmpdir(), "boop-edits-"));
  const path = join(directory, "chat.sqlite");
  const first = edit(rumor("First edit", targetId, { at: time + 1 }));
  const second = edit(rumor("Second edit", first.id, { at: time + 2 }));
  try {
    {
      using sqlite = new Database(path);
      const chat = createMessagingRepository(database(sqlite));
      chat.receive(original());
      chat.receiveEdit(second);
      sqlite.exec(`CREATE TRIGGER test_abort_edit BEFORE UPDATE OF revision_id ON messages
        BEGIN SELECT raise(ABORT, 'test atomic update failure'); END;`);
      expect(() => chat.receiveEdit(first)).toThrow(
        "test atomic update failure",
      );
      expect(chat.message(alice.pubkey, targetId)?.body).toBe("Original");
      expect(sqlite.query("SELECT * FROM message_revisions").all()).toEqual([]);
      sqlite.exec("DROP TRIGGER test_abort_edit");
    }
    {
      using sqlite = new Database(path);
      const chat = createMessagingRepository(drizzle(sqlite, { schema }));
      expect(chat.receiveEdit(first)).toBe("applied");
      expect(chat.message(alice.pubkey, targetId)?.revisionId).toBe(second.id);
    }
    {
      using sqlite = new Database(path);
      const chat = createMessagingRepository(drizzle(sqlite, { schema }));
      expect(
        chat
          .revisions(alice.pubkey, targetId)
          ?.versions.map(({ body }) => body),
      ).toEqual(["Original", "First edit", "Second edit"]);
    }
  } finally {
    rmSync(path, { force: true });
    rmdirSync(directory);
  }
});

test("authenticates one edit ID across separate recipient and sender gift wraps", async () => {
  const value = rumor("Edited\nsecond line");
  const recipient = (await wrapRumor(ndk, value, bob.pubkey, alice)).rawEvent();
  const copy = (await wrapRumor(ndk, value, alice.pubkey, alice)).rawEvent();
  expect(recipient.kind).toBe(giftWrapKind);
  expect(recipient.id).not.toBe(copy.id);
  expect(recipient.content).not.toContain("Edited");
  expect(recipient.tags).toEqual([["p", bob.pubkey]]);
  expect(await unwrapPrivateEvent(recipient, bob)).toEqual(edit(value));
  expect(await unwrapPrivateEvent(copy, alice)).toEqual(
    edit(value, alice.pubkey),
  );
  expect(await unwrapPrivateEvent(recipient, charlie)).toBeNull();
  expect(
    await unwrapPrivateEvent(recipient, bob, (key) => key === alice.pubkey),
  ).toBeNull();
  expect(
    await unwrapPrivateEvent({ ...recipient, content: copy.content }, bob),
  ).toBeNull();
  const wrongSeal = (
    await wrapRumor(ndk, value, bob.pubkey, charlie)
  ).rawEvent();
  expect(await unwrapPrivateEvent(wrongSeal, bob)).toBeNull();
});

test("rejects noncanonical IDs, payloads, timestamp and participant tags", async () => {
  const valid = rumor("x".repeat(maxMessageLength));
  expect(parseRumor(valid)).toEqual(valid);
  expect(parseRumor({ ...valid, content: "changed" })).toBeNull();
  for (const text of ["", "  ", " padded ", "x".repeat(maxMessageLength + 1)])
    expect(parseEditRumor(rumor(text), bob.pubkey)).toBeNull();
  expect(parseEditRumor(rumor("valid", "invalid-id"), bob.pubkey)).toBeNull();
  expect(
    parseEditRumor(
      rumor("future", targetId, { at: Date.now() / 1_000 + 800 }),
      bob.pubkey,
    ),
  ).toBeNull();
  const { id: _id, ...core } = valid;
  for (const malformed of [
    createRumor({
      ...core,
      tags: [
        ["p", bob.pubkey],
        ["e", otherId],
      ],
    }),
    createRumor({
      ...core,
      tags: [
        ["p", bob.pubkey],
        ["p", alice.pubkey],
        ["e", targetId],
      ],
    }),
    createRumor({
      ...core,
      content: JSON.stringify({ ...edit(valid).edit, author: alice.pubkey }),
    }),
    createRumor({ ...core, content: '{"v":2}' }),
    createRumor({ ...core, content: "broken JSON" }),
  ]) {
    const wrapped = (
      await wrapRumor(ndk, malformed, bob.pubkey, alice)
    ).rawEvent();
    expect(await unwrapPrivateEvent(wrapped, bob)).toBeNull();
  }
});

test("reconciles ancestors before or after the original and preserves same-second forks", () => {
  const one = rumor("First edit");
  const two = rumor("Second edit", one.id);
  const fork = rumor("Independent later edit", targetId, { at: time + 90 });
  const sibling = rumor("Sibling", one.id);
  const expected = [two, sibling].sort((a, b) => b.id.localeCompare(a.id))[0];
  if (!expected) throw new Error("Missing expected revision");
  for (const order of [
    [fork, sibling, two, one],
    [one, two, sibling, fork],
  ]) {
    using sqlite = new Database(":memory:");
    const db = database(sqlite);
    const chat = createMessagingRepository(db);
    for (const value of order.slice(0, 3))
      expect(chat.receiveEdit(edit(value))).toBe("unresolved");
    const repeated = order[0];
    if (!repeated) throw new Error("Missing replay fixture");
    const revision = chat.historyRevision(alice.pubkey);
    expect(chat.receiveEdit(edit(repeated))).toBe("duplicate");
    expect(chat.historyRevision(alice.pubkey)).toBe(revision);
    expect(chat.conversation(alice.pubkey)).toBeUndefined();
    const reopened = createMessagingRepository(db);
    expect(reopened.receive(original())).toBe(true);
    const last = order[3];
    if (!last) throw new Error("Missing final delivery");
    expect(reopened.receiveEdit(edit(last))).toBe("applied");
    expect(reopened.receiveEdit(edit(last))).toBe("duplicate");
    const timeline = reopened.revisions(alice.pubkey, targetId);
    expect(timeline?.versions.map(({ depth }) => depth)).toEqual([
      0, 1, 2, 2, 1,
    ]);
    expect(timeline?.versions[0]).toMatchObject({
      body: "Original",
      revisionId: targetId,
      timestamp: time * 1_000,
    });
    expect(timeline?.current).toBe(expected.id);
    expect(timeline?.incomplete).toBe(false);
    expect(reopened.conversation(alice.pubkey)).toMatchObject({
      unread: 1,
      updatedAt: time * 1_000,
      preview: edit(expected).edit.text,
    });
    expect(reopened.history(alice.pubkey).messages).toMatchObject([
      {
        id: original().id,
        sentAt: time * 1_000,
        editedAt: time * 1_000,
        body: edit(expected).edit.text,
      },
    ]);
  }
});

test("validates author, conversation, type, causal time, and deletion at persistence", () => {
  using sqlite = new Database(":memory:");
  const db = database(sqlite);
  const chat = createMessagingRepository(db);
  chat.receive(original());
  expect(
    chat.receiveEdit(
      edit(
        rumor("Forged", targetId, {
          author: bob.pubkey,
          recipient: alice.pubkey,
        }),
      ),
    ),
  ).toBe("rejected");
  expect(
    chat.receiveEdit(
      edit(
        rumor("Wrong peer", targetId, { recipient: charlie.pubkey }),
        charlie.pubkey,
      ),
    ),
  ).toBe("rejected");
  expect(
    chat.receiveEdit(
      edit(rumor("Older than original", targetId, { at: time - 1 })),
    ),
  ).toBe("rejected");
  chat.receive({
    ...original(),
    id: otherId,
    eventId: otherId,
    location: true,
  });
  expect(
    chat.receiveEdit(
      edit(rumor("Replace location", otherId, { target: otherId })),
    ),
  ).toBe("rejected");
  const first = rumor("First edit");
  chat.receiveEdit(edit(first));
  expect(chat.receiveEdit(edit(rumor("Unrelated parent", otherId)))).toBe(
    "rejected",
  );
  const missing = rumor("Missing parent", "c3".repeat(32));
  expect(chat.receiveEdit(edit(missing))).toBe("unresolved");
  expect(chat.revisions(alice.pubkey, targetId)?.incomplete).toBe(true);
  const privacy = createPrivacy(db, chat, bob.pubkey);
  privacy.block(alice.pubkey);
  expect(chat.receiveEdit(edit(rumor("Blocked", first.id)))).toBe("rejected");
  expect(chat.revisions(alice.pubkey, targetId)?.incomplete).toBe(false);
  privacy.unblock(alice.pubkey);
  chat.deleteMessages(alice.pubkey, [original().id]);
  expect(chat.receiveEdit(edit(rumor("After deletion", first.id)))).toBe(
    "rejected",
  );
  expect(chat.receive(original())).toBe(false);
  expect(chat.revisions(alice.pubkey, targetId)).toBeNull();
  expect(db.select().from(schema.messageRevisions).all()).toEqual([]);
  expect(db.select().from(schema.pendingMessageEdits).all()).toEqual([]);
});

test("keeps original identity, pins, replies and order while invalidating derived text", () => {
  using sqlite = new Database(":memory:");
  const db = database(sqlite);
  const chat = createMessagingRepository(db);
  chat.receive(original());
  const later = {
    ...original(),
    id: otherId,
    eventId: otherId,
    sentAt: (time + 1) * 1_000,
    replyTo: targetId,
    body: "Reply",
  };
  chat.receive(later);
  chat.toggleMessagePin(alice.pubkey, original().id);
  db.insert(schema.messageTranslations)
    .values({
      messageId: original().id,
      targetLanguage: "he",
      sourceLanguage: "en",
      translatedText: "ישן",
    })
    .run();
  const value = rumor("Changed", targetId, { at: time + 30 });
  chat.receiveEdit(edit(value));
  expect(db.select().from(schema.messageTranslations).all()).toEqual([]);
  const [first, reply] = chat.history(alice.pubkey).messages;
  expect(first).toMatchObject({
    id: original().id,
    body: "Changed",
    eventId: targetId,
    isPinned: true,
  });
  expect(reply).toMatchObject({ replyTo: targetId, id: later.id });
  if (!first || !reply) throw new Error("Missing history rows");
  const participants = {
    self: { _id: bob.pubkey },
    peer: { _id: alice.pubkey },
  };
  expect(
    toDetailMessage(first, undefined, participants, "Unavailable"),
  ).toMatchObject({
    _id: original().id,
    createdAt: time * 1_000,
    editedAt: (time + 30) * 1_000,
    isEdited: true,
    text: "Changed",
  });
  expect(
    toDetailMessage(reply, first, participants, "Unavailable").replyMessage
      ?.text,
  ).toBe("Changed");
  expect(chat.conversation(alice.pubkey)?.preview).toBe("Reply");
  expect(chat.conversation(alice.pubkey)?.unread).toBe(2);
});

test("authorizes previews against the winning edit's URL", () => {
  using sqlite = new Database(":memory:");
  const chat = createMessagingRepository(database(sqlite));
  const before = "https://example.com/old";
  const after = "https://example.com/new";
  chat.receive({ ...original(), body: before });
  const target = { peer: alice.pubkey, id: original().id };
  const privacy = {
    isBlocked: () => false,
    request: () => [],
    messagePermission: () => "allow" as const,
  };
  expect(authorizePreview({ ...target, url: before }, chat, privacy)).toBe(
    true,
  );
  chat.receiveEdit(edit(rumor(after)));
  expect(authorizePreview({ ...target, url: before }, chat, privacy)).toBe(
    false,
  );
  expect(authorizePreview({ ...target, url: after }, chat, privacy)).toBe(true);
});

test("retains failed edits across repository restarts and acknowledges sender copies independently", () => {
  using sqlite = new Database(":memory:");
  const db = database(sqlite);
  const chat = createMessagingRepository(db);
  const row = {
    ...original(),
    peerKey: bob.pubkey,
    direction: "outgoing" as const,
  };
  chat.enqueue(row);
  const value = rumor("Changed", targetId, { at: time + 3 });
  const event = edit(value, alice.pubkey);
  const json = JSON.stringify(value);
  expect(chat.enqueueEdit(row.id, event, json)).toBe(false);
  chat.setStatus(row.id, "sent");
  chat.saveDraft(bob.pubkey, "Unrelated draft", null);
  expect(chat.enqueueEdit(row.id, event, json)).toBe(true);
  const competing = rumor("Another edit");
  expect(
    chat.enqueueEdit(
      row.id,
      edit(competing, alice.pubkey),
      JSON.stringify(competing),
    ),
  ).toBe(false);
  chat.failEdit(bob.pubkey, value.id, "relay-rejected");
  const reopened = createMessagingRepository(db);
  expect(reopened.message(bob.pubkey, row.id)?.body).toBe("Original");
  reopened.retryEdit(bob.pubkey, row.id);
  expect(reopened.editOutbox(false)).toMatchObject([
    { revisionId: value.id, rumorJson: json, status: "pending" },
  ]);
  expect(reopened.finishEditDelivery(event)).toBe(true);
  expect(reopened.message(bob.pubkey, row.id)?.body).toBe("Changed");
  expect(reopened.receiveEdit(event)).toBe("duplicate");
  reopened.finishEditCopy(bob.pubkey, value.id, false);
  expect(reopened.editOutbox(true)).toMatchObject([
    { revisionId: value.id, status: "copy-failed", rumorJson: json },
  ]);
  reopened.retryEdit(bob.pubkey, row.id);
  expect(reopened.editOutbox(true)).toMatchObject([
    { revisionId: value.id, status: "copy-pending", rumorJson: json },
  ]);
  reopened.finishEditCopy(bob.pubkey, value.id, true);
  expect(reopened.editOutbox(true)).toEqual([]);
  expect(reopened.revisions(bob.pubkey, row.id)?.versions).toHaveLength(2);
  expect(reopened.draft(bob.pubkey)?.draft).toBe("Unrelated draft");
});
