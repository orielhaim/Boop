import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import NDK, { NDKPrivateKeySigner, NDKUser } from "@nostr-dev-kit/ndk";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { finalizeEvent } from "nostr-tools/pure";
import { createConversationFeed } from "../src/core/messaging/conversations";
import { createHistoryLoader } from "../src/core/messaging/history";
import {
  createRumor,
  giftWrapKind,
  messageEditKind,
  messageKind,
  parseReaction,
  reactionKind,
  unwrapPrivateEvent,
  wrapRumor,
} from "../src/core/messaging/nip17";
import { createRelayService } from "../src/core/nostr/relay-service";
import { createMessagingService } from "../src/core/messaging/runtime";
import { createPrivacy } from "../src/core/privacy";
import { createMessagingRepository } from "../src/db/messaging";
import { initializeTestDatabase } from "./db-fixture";
import * as schema from "../src/db/schema";

const ndk = new NDK({ enableOutboxModel: false });
const alice = new NDKPrivateKeySigner("01".repeat(32));
const bob = new NDKPrivateKeySigner("02".repeat(32));
const charlie = new NDKPrivateKeySigner("03".repeat(32));
const timestamp = 1_724_000_010;
const quoteId = "42".repeat(32);

test("NDK keeps a live inbox after EOSE and catches up after restarting the session", async () => {
  using sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  const repo = createMessagingRepository(db);
  const privacy = createPrivacy(db, repo, bob.pubkey);
  privacy.set("requests", true);
  const history = createHistoryLoader(repo);
  const feed = createConversationFeed(repo, history, () => undefined);
  const stopFeed = feed.start();
  const state = new Map<string, string>();
  const readState = (key: string) => state.get(key) ?? null;
  const writeState = (key: string, value: string) => {
    state.set(key, value);
  };
  const relays = createRelayService({ signer: bob, readState, writeState });
  const runtime = createMessagingService({
    relays,
    signer: bob,
    chat: repo,
    privacy,
    readState,
    writeState,
    createId: () => crypto.randomUUID(),
  });
  const envelopes: Awaited<ReturnType<typeof wrapRumor>>[] = [];
  const emitters = new Set<
    (event: Awaited<ReturnType<typeof wrapRumor>>) => void
  >();
  const createWrap = async (body: string) => {
    const rumor = createRumor({
      kind: messageKind,
      pubkey: alice.pubkey,
      created_at: Math.floor(Date.now() / 1_000),
      content: body,
      tags: [["p", bob.pubkey]],
    });
    const event = await wrapRumor(ndk, rumor, bob.pubkey, alice);
    envelopes.push(event);
    return { rumor, event };
  };
  const server = Bun.serve<{
    callbacks: Map<
      string,
      (event: Awaited<ReturnType<typeof wrapRumor>>) => void
    >;
  }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req, { data: { callbacks: new Map() } }))
        return undefined;
      return new Response("Expected a relay connection", { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const input: unknown = JSON.parse(String(data));
        if (!Array.isArray(input)) return;
        const [type, id, filter] = input;
        if (typeof id !== "string") return;
        if (type === "CLOSE") {
          const emit = ws.data.callbacks.get(id);
          if (emit) emitters.delete(emit);
          ws.data.callbacks.delete(id);
          return;
        }
        if (type !== "REQ") return;
        const emit = (event: Awaited<ReturnType<typeof wrapRumor>>) => {
          if (
            filter?.kinds?.includes(event.kind) &&
            (!filter.since || (event.created_at ?? -1) >= filter.since)
          )
            ws.send(JSON.stringify(["EVENT", id, event.rawEvent()]));
        };
        ws.data.callbacks.set(id, emit);
        emitters.add(emit);
        for (const event of envelopes) emit(event);
        ws.send(JSON.stringify(["EOSE", id]));
      },
      close(ws) {
        for (const emit of ws.data.callbacks.values()) emitters.delete(emit);
      },
    },
  });
  const url = `ws://127.0.0.1:${server.port}/`;
  const config = { inbox: [url], general: [], discovery: [], intent: null };
  async function until(condition: () => boolean) {
    const deadline = Date.now() + 2_000;
    while (!condition() && Date.now() < deadline) await Bun.sleep(10);
    expect(condition()).toBe(true);
  }

  try {
    const initial = await createWrap("Historical");
    const edit = createRumor({
      kind: messageEditKind,
      pubkey: alice.pubkey,
      created_at: initial.rumor.created_at,
      tags: [
        ["p", bob.pubkey],
        ["e", initial.rumor.id],
      ],
      content: JSON.stringify({
        v: 1,
        targetId: initial.rumor.id,
        previousRevisionId: initial.rumor.id,
        text: "Historical, edited",
      }),
    });
    envelopes.push(await wrapRumor(ndk, edit, bob.pubkey, alice));
    runtime.start();
    relays.start(config);
    await until(() => privacy.pendingCount() === 1 && state.size > 0);
    expect(feed.getUnreadCount()).toBe(0);
    expect(repo.conversation(alice.pubkey)).toBeUndefined();
    expect(db.select().from(schema.pendingMessageEdits).all()).toEqual([]);
    const extra = await createWrap("Second message before approval");
    expect(privacy.accept(alice.pubkey)).toBe(true);
    await until(() => feed.getUnreadCount() === 1 && state.size > 0);
    expect(repo.history(alice.pubkey).messages[0]?.eventId).toBe(
      initial.rumor.id,
    );
    runtime.catchupRequest(alice.pubkey);
    await until(
      () =>
        feed.getUnreadCount() === 2 &&
        repo.message(alice.pubkey, initial.rumor.id)?.body ===
          "Historical, edited",
    );
    expect(
      repo
        .revisions(alice.pubkey, initial.rumor.id)
        ?.versions.map(({ body }) => body),
    ).toEqual(["Historical", "Historical, edited"]);
    expect(repo.message(alice.pubkey, extra.rumor.id)?.body).toBe(
      "Second message before approval",
    );
    const live = await createWrap("Live after EOSE");
    for (const emit of emitters) {
      emit(live.event);
      emit(live.event);
    }
    await until(() => feed.getUnreadCount() === 3);
    runtime.stop();
    relays.stop();
    await createWrap("Missed while away");
    runtime.start();
    relays.start(config);
    await until(
      () =>
        feed.getUnreadCount() === 4 &&
        runtime.getInboxSync() === "idle" &&
        feed.getSnapshot()?.rows[0]?.unread === 4,
    );
    expect(feed.getSnapshot()?.rows[0]).toMatchObject({ unread: 4 });
    expect(repo.history(alice.pubkey).messages).toHaveLength(4);
    privacy.block(alice.pubkey);
    await until(() => feed.getUnreadCount() === 0);
    expect(repo.history(alice.pubkey).messages).toHaveLength(4);
  } finally {
    runtime.stop();
    relays.stop();
    stopFeed();
    history.dispose();
    void server.stop(true);
  }
});

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
  const blocked = new NDKPrivateKeySigner("02".repeat(32));
  const decrypt = blocked.decrypt.bind(blocked);
  let decryptions = 0;
  blocked.decrypt = (...args) => {
    decryptions++;
    return decrypt(...args);
  };
  expect(
    await unwrapPrivateEvent(
      received.rawEvent(),
      blocked,
      (key) => key === alice.pubkey,
    ),
  ).toBeNull();
  expect(decryptions).toBe(1);

  using sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
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
