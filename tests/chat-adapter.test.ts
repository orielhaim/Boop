import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import NDK, { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  equalDetailMessage,
  toDetailMessage,
} from "../src/components/messages/detail-adapter";
import {
  createRumor,
  messageKind,
  unwrapPrivateEvent,
  wrapRumor,
} from "../src/core/messaging/nip17";
import {
  createMessagingRepository,
  type MessageRecord,
} from "../src/db/messaging";
import migrations from "../src/db/migrations/bundle";
import * as schema from "../src/db/schema";

const participants = {
  self: { _id: "local-key", name: "You" },
  peer: { _id: "peer-key", name: "Alex" },
};
const pending: MessageRecord = {
  id: "optimistic-local-id",
  eventId: "canonical-rumor-id",
  peerKey: participants.peer._id,
  direction: "outgoing",
  body: "שלום! Are you free at 8?",
  sentAt: 1_724_000_010_000,
  replyTo: "quoted-rumor-id",
  senderKey: participants.self._id,
  recipientKey: participants.peer._id,
  status: "pending",
  editedAt: null,
  revisionId: null,
  failure: null,
  deletedAt: null,
  isUnread: false,
  rumorJson: null,
  contentType: "text",
  reactions: [
    { author: "peer-key", emoji: "👍" },
    { author: "local-key", emoji: "👍" },
    { author: "local-key", emoji: "👍" },
  ],
};
const quoted: MessageRecord = {
  ...pending,
  id: "original-local-id",
  eventId: pending.replyTo,
  direction: "incoming",
  body: "עוד מעט?",
  senderKey: participants.peer._id,
  recipientKey: participants.self._id,
  status: "received",
};

test("Chat keeps a stable local ID and maps a canonical quote to its local target", () => {
  const queued = toDetailMessage(pending, quoted, participants, "Unavailable");
  expect(queued).toMatchObject({
    _id: "optimistic-local-id",
    user: participants.self,
    text: "שלום! Are you free at 8?",
    createdAt: 1_724_000_010_000,
    replyMessage: {
      _id: "original-local-id",
      text: "עוד מעט?",
      user: participants.peer,
    },
    reactions: [{ emoji: "👍", userIds: ["local-key", "peer-key"] }],
    pending: true,
    sent: false,
    linkPreview: null,
  });
  const accepted = toDetailMessage(
    { ...pending, status: "sent" },
    quoted,
    participants,
    "Unavailable",
  );
  expect(accepted._id).toBe(queued._id);
  expect(accepted).toMatchObject({ pending: false, sent: true });
  expect(accepted.received).toBeUndefined();
  expect(equalDetailMessage(queued, accepted)).toBe(false);
});

test("Chat avoids invented quote text and does not treat sender-copy sync as relay acceptance", () => {
  const synced = toDetailMessage(
    { ...pending, status: "synced" },
    { ...quoted, deletedAt: 100 },
    participants,
    "Unavailable",
  );
  expect(synced.replyMessage).toEqual({
    _id: "quoted-rumor-id",
    text: "Unavailable",
    user: { _id: "" },
  });
  expect(synced).toMatchObject({
    pending: false,
    sent: false,
    isFailed: false,
  });
  const independentlyMapped = toDetailMessage(
    { ...pending, status: "synced" },
    undefined,
    participants,
    "Unavailable",
  );
  expect(equalDetailMessage(synced, independentlyMapped)).toBe(true);
});

test("An authenticated wrapped private message reaches Chat with the rumor identity", async () => {
  const ndk = new NDK({ enableOutboxModel: false });
  const sender = new NDKPrivateKeySigner("04".repeat(32));
  const recipient = new NDKPrivateKeySigner("05".repeat(32));
  const rumor = createRumor({
    kind: messageKind,
    pubkey: sender.pubkey,
    created_at: 1_724_000_010,
    content: "Hello from ירושלים",
    tags: [["p", recipient.pubkey]],
  });
  const wrap = await wrapRumor(ndk, rumor, recipient.pubkey, sender);
  const event = await unwrapPrivateEvent(wrap.rawEvent(), recipient);
  if (event?.type !== "message") throw new Error("Expected a private message");

  using sqlite = new Database(":memory:");
  for (const migration of Object.values(migrations.migrations))
    sqlite.exec(migration);
  const repo = createMessagingRepository(drizzle(sqlite, { schema }));
  repo.receive({ ...event, eventId: event.id, direction: "incoming" });
  const [row] = repo.history(sender.pubkey).messages;
  if (!row) throw new Error("Expected persisted private message");
  const mapped = toDetailMessage(
    row,
    undefined,
    {
      self: { _id: recipient.pubkey },
      peer: { _id: sender.pubkey },
    },
    "Unavailable",
  );
  expect(mapped).toMatchObject({
    _id: rumor.id,
    text: "Hello from ירושלים",
    user: { _id: sender.pubkey },
    createdAt: 1_724_000_010_000,
    unread: true,
  });
  expect(mapped._id).not.toBe(wrap.id);
});
