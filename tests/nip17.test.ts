import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import NDK, { NDKPrivateKeySigner, NDKUser } from "@nostr-dev-kit/ndk";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { finalizeEvent } from "nostr-tools/pure";
import {
  createRumor,
  giftWrapKind,
  messageKind,
  parseReaction,
  reactionKind,
  unwrapPrivateEvent,
  wrapRumor,
} from "../src/core/messaging/nip17";
import { createMessagingRepository } from "../src/db/messaging";
import migrations from "../src/db/migrations/bundle";
import * as schema from "../src/db/schema";

const ndk = new NDK({ enableOutboxModel: false });
const alice = new NDKPrivateKeySigner("01".repeat(32));
const bob = new NDKPrivateKeySigner("02".repeat(32));
const charlie = new NDKPrivateKeySigner("03".repeat(32));
const timestamp = 1_724_000_010;
const quoteId = "42".repeat(32);

test("recipient and sender decrypt distinct gift wraps to the same unsigned rumor", async () => {
  const rumor = createRumor({
    kind: messageKind,
    pubkey: alice.pubkey,
    created_at: timestamp,
    content: "שלום! Are you free at 8?",
    tags: [
      ["p", bob.pubkey],
      ["e", quoteId],
    ],
  });
  const received = await wrapRumor(ndk, rumor, bob.pubkey, alice);
  const receivedElsewhere = await wrapRumor(ndk, rumor, bob.pubkey, alice);
  const senderCopy = await wrapRumor(ndk, rumor, alice.pubkey, alice);
  expect(new Set([received.id, receivedElsewhere.id, senderCopy.id]).size).toBe(
    3,
  );
  expect(received.content.includes(rumor.content)).toBe(false);
  expect(received.pubkey).not.toBe(alice.pubkey);
  expect(await unwrapPrivateEvent(received.rawEvent(), charlie)).toBeNull();

  using sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of Object.values(migrations.migrations))
    sqlite.exec(migration);
  const repo = createMessagingRepository(drizzle(sqlite, { schema }));
  for (const wrap of [received, receivedElsewhere]) {
    const event = await unwrapPrivateEvent(wrap.rawEvent(), bob);
    expect(event).toEqual({
      type: "message",
      id: rumor.id,
      peerKey: alice.pubkey,
      senderKey: alice.pubkey,
      recipientKey: bob.pubkey,
      body: "שלום! Are you free at 8?",
      sentAt: timestamp * 1_000,
      replyTo: quoteId,
    });
    if (event?.type !== "message") throw new Error("Unexpected event kind");
    repo.receive({ ...event, eventId: event.id, direction: "incoming" });
  }
  expect(repo.conversation(alice.pubkey)?.unread).toBe(1);
  expect(repo.history(alice.pubkey).messages.map((item) => item.id)).toEqual([
    rumor.id,
  ]);
  expect(await unwrapPrivateEvent(senderCopy.rawEvent(), alice)).toMatchObject({
    id: rumor.id,
    peerKey: bob.pubkey,
  });
});

test("a valid envelope cannot authenticate a forged rumor author or a forged signature", async () => {
  const forged = createRumor({
    kind: messageKind,
    pubkey: charlie.pubkey,
    created_at: timestamp,
    content: "Not written by Charlie",
    tags: [["p", bob.pubkey]],
  });
  const wrapper = await wrapRumor(ndk, forged, bob.pubkey, alice);
  expect(await unwrapPrivateEvent(wrapper.rawEvent(), bob)).toBeNull();

  const real = createRumor({ ...forged, pubkey: alice.pubkey });
  const realWrapper = await wrapRumor(ndk, real, bob.pubkey, alice);
  expect(
    await unwrapPrivateEvent(
      { ...realWrapper.rawEvent(), sig: "00".repeat(64) },
      bob,
    ),
  ).toBeNull();
  expect(
    await unwrapPrivateEvent(
      { ...realWrapper.rawEvent(), id: "00".repeat(32) },
      bob,
    ),
  ).toBeNull();

  const malformedSeal = finalizeEvent(
    {
      kind: 13,
      created_at: timestamp,
      tags: [],
      content: await alice.encrypt(
        new NDKUser({ pubkey: bob.pubkey }),
        JSON.stringify({ ...real, id: "00".repeat(32) }),
        "nip44",
      ),
    },
    new Uint8Array(32).fill(1),
  );
  const wrapperSigner = new NDKPrivateKeySigner("09".repeat(32));
  const validWrapper = finalizeEvent(
    {
      kind: giftWrapKind,
      created_at: timestamp,
      tags: [["p", bob.pubkey]],
      content: await wrapperSigner.encrypt(
        new NDKUser({ pubkey: bob.pubkey }),
        JSON.stringify(malformedSeal),
        "nip44",
      ),
    },
    new Uint8Array(32).fill(9),
  );
  expect(await unwrapPrivateEvent(validWrapper, bob)).toBeNull();
});

test("kind 7 reactions are private, preserve their target, and skip remote emoji media", async () => {
  const reaction = createRumor({
    kind: reactionKind,
    pubkey: bob.pubkey,
    created_at: timestamp,
    content: "👍🏾",
    tags: [
      ["p", alice.pubkey],
      ["e", quoteId],
      ["k", "14"],
    ],
  });
  const wrapped = await wrapRumor(ndk, reaction, alice.pubkey, bob);
  expect(wrapped.kind).toBe(giftWrapKind);
  expect(await unwrapPrivateEvent(wrapped.rawEvent(), alice)).toMatchObject({
    type: "reaction",
    senderKey: bob.pubkey,
    recipientKey: alice.pubkey,
    targetEventId: quoteId,
    emoji: "👍🏾",
  });
  expect(parseReaction(":tracking-image:")).toBeNull();
  expect(parseReaction("abc")).toBeNull();
  expect(parseReaction("+")).toBe("👍");
});
