import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import NDK, { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { toDetailMessage } from "../src/components/messages/detail-adapter";
import {
  parseRumor,
  unwrapPrivateEvent,
  wrapRumor,
} from "../src/core/messaging/nip17";
import { createMessagingService } from "../src/core/messaging/runtime";
import {
  createTimeLockOpener,
  encryptTimeLock,
  maxTimeLockDate,
  maxTimeLockEnvelope,
  parseTimeLock,
  scheduleUnlock,
  TimeLockError,
  timeLockKind,
} from "../src/core/messaging/special-messages/timelock";
import { createUnlockScheduler } from "../src/core/messaging/special-messages/unlock-scheduler";
import { createMessagingRepository } from "../src/db/messaging";
import { initializeTestDatabase } from "./db-fixture";
import * as schema from "../src/db/schema";
import { createTranslationCache } from "../src/db/translations";

// Generated with official tle v1.2.0: -e -f -a -r 1000000
const body = "Boop Quicknet שלום 🌙";
const ciphertext = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IHRsb2NrIDEwMDAwMDAgNTJkYjliYTcw
ZTBjYzBmNmVhZjc4MDNkZDA3NDQ3YTFmNTQ3NzczNWZkM2Y2NjE3OTJiYTk0NjAw
Yzg0ZTk3MQpqN3hUaGdScHppRjA1cmpqNmxJb3dpNm1pWHFFbzNqamh4ZGtIWXor
WmtkcVRQOWhLTEFJa0pVRFZiVFM3OEQ0CkZsdjhxQXg1K3d1aXpRTHpxeE9VMkxi
a2NtN3VsdGcrQWt4ck9QTHQxNnQ0OGZQa29mZDFzeUpSQ3ZDUjUwYjcKZUxNd1ZZ
NTVZSFVVU1laVExaSm1nSWNWYWJxYzNTYUUvdm5NTHdXYzc3MAotLS0gYU5PNG8r
SDZNWnFjaVJveVB5UDE1QWZONW5GZy9aL0txWVJxeE9HWHU3MAoTuWijZw094rcg
J6YxT2JqdGxI+hGFvpEA3ZGbJOBmCqnCbFod3fy/TqJmZro3zXU2jXfgTykSvA7k
aA==
-----END AGE ENCRYPTED FILE-----
`;
const beacon = {
  round: 1_000_000,
  randomness:
    "b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3",
  signature:
    "83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72",
};
// The round timestamp is calculated directly from drand's genesis.
const roundTime = 1_695_803_364_000;
function decodeArmor(armor: string) {
  return atob(armor.trim().split("\n").slice(1, -1).join(""));
}

function encodeArmor(binary: string) {
  const lines = btoa(binary)
    .match(/.{1,64}/g)
    ?.join("\n");
  return `-----BEGIN AGE ENCRYPTED FILE-----\n${lines}\n-----END AGE ENCRYPTED FILE-----\n`;
}

const historical = (() => {
  const content = parseTimeLock({
    type: "timelock",
    v: 1,
    ciphertext,
    ...scheduleUnlock(roundTime),
  });
  if (!content) throw new Error("Go Quicknet fixture did not parse");
  return content;
})();

test("chooses the first scheduled round at or after UTC instants", () => {
  const genesis = 1_692_803_367_000;
  expect(scheduleUnlock(genesis)).toMatchObject({
    unlockRound: 1,
    roundTime: genesis,
  });
  expect(scheduleUnlock(roundTime).unlockRound).toBe(beacon.round);
  expect(scheduleUnlock(roundTime - 1).roundTime).toBe(roundTime);
  expect(scheduleUnlock(roundTime + 1).roundTime).toBe(roundTime + 3_000);
  expect(scheduleUnlock(maxTimeLockDate).roundTime).toBeGreaterThanOrEqual(
    maxTimeLockDate,
  );
  expect(() => scheduleUnlock(Number.NaN)).toThrow();
  expect(() => scheduleUnlock(maxTimeLockDate + 1)).toThrow();

  const first = Date.parse("2025-11-02T01:30:00-04:00");
  const second = Date.parse("2025-11-02T01:30:00-05:00");
  expect(
    scheduleUnlock(second).unlockRound - scheduleUnlock(first).unlockRound,
  ).toBe(1_200);
  expect(scheduleUnlock(second)).toEqual(
    scheduleUnlock(Date.parse("2025-11-02T06:30:00Z")),
  );
});

test("binds metadata and the AGE recipient to the pinned chain and round", () => {
  expect(parseTimeLock(historical)).toEqual(historical);
  expect(
    parseTimeLock({ ...historical, chainHash: "ab".repeat(32) }),
  ).toBeNull();
  expect(
    parseTimeLock({ ...historical, requestedAt: roundTime + 1 }),
  ).toBeNull();
  expect(
    parseTimeLock({ ...historical, ciphertext: "A".repeat(18_000) }),
  ).toBeNull();
  expect(
    parseTimeLock({ ...historical, ...scheduleUnlock(roundTime + 1) }),
  ).toBeNull();
  expect(
    parseTimeLock({
      ...historical,
      ciphertext: encodeArmor(
        decodeArmor(ciphertext).replace(historical.chainHash, "ab".repeat(32)),
      ),
    }),
  ).toBeNull();
  expect(
    parseTimeLock({
      ...historical,
      ciphertext: encodeArmor(
        decodeArmor(ciphertext).replace(
          "\n--- ",
          "\n-> other-recipient\nAA\n--- ",
        ),
      ),
    }),
  ).toBeNull();
});

test("encrypts future UTF-8 locally and stays sealed without a beacon", async () => {
  let fetched = false;
  const open = createTimeLockOpener(undefined, async () => {
    fetched = true;
    return beacon;
  });
  const sealed = await encryptTimeLock(body, Date.now() + 60_000);
  expect(sealed.ciphertext).not.toContain(body);
  await expect(open(sealed)).rejects.toMatchObject({ code: "not-ready" });
  expect(fetched).toBe(false);
  await expect(encryptTimeLock(" ", Date.now() + 10_000)).rejects.toThrow(
    "invalid-message",
  );
  await expect(
    encryptTimeLock("a".repeat(4_001), Date.now() + 10_000),
  ).rejects.toThrow("invalid-message");
  await expect(encryptTimeLock(body, Date.now() - 1)).rejects.toThrow(
    "unlock-time",
  );
});

test("opens the Go fixture once the authentic Quicknet beacon is available, including offline cache reload", async () => {
  let fetches = 0;
  let stored: unknown;
  const cache = {
    read: () => stored,
    store: (entry: unknown) => {
      stored = entry;
    },
  };
  const open = createTimeLockOpener(cache, async () => {
    fetches++;
    return beacon;
  });
  expect(await Promise.all([open(historical), open(historical)])).toEqual([
    body,
    body,
  ]);
  expect(fetches).toBe(1);
  const offline = createTimeLockOpener(cache, async () => {
    throw new Error("Unexpected network request");
  });
  expect(await offline(historical)).toBe(body);
  const age = decodeArmor(ciphertext);
  await expect(
    open({
      ...historical,
      ciphertext: encodeArmor(
        age.slice(0, -1) +
          String.fromCharCode(age.charCodeAt(age.length - 1) ^ 1),
      ),
    }),
  ).rejects.toMatchObject({ code: "decryption" });
});

test("rejects wrong rounds and signatures before using the decryption key", async () => {
  let cached = false;
  const cache = {
    read: () => undefined,
    store: () => {
      cached = true;
    },
  };
  const wrongRound = createTimeLockOpener(cache, async () => ({
    ...beacon,
    round: beacon.round + 1,
  }));
  await expect(wrongRound(historical)).rejects.toMatchObject({
    code: "verification",
  });
  const signature = `93${beacon.signature.slice(2)}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(Buffer.from(signature, "hex")),
  );
  const wrongSignature = createTimeLockOpener(cache, async () => ({
    ...beacon,
    signature,
    randomness: Buffer.from(digest).toString("hex"),
  }));
  await expect(wrongSignature(historical)).rejects.toMatchObject({
    code: "verification",
  });
  expect(cached).toBe(false);
  const offline = createTimeLockOpener(undefined, async () => {
    throw new TimeLockError("network");
  });
  await expect(offline(historical)).rejects.toMatchObject({ code: "network" });
});

const alice = new NDKPrivateKeySigner("01".repeat(32));
const bob = new NDKPrivateKeySigner("02".repeat(32));
const ndk = new NDK({ enableOutboxModel: false });
const peerKey = bob.pubkey;
const participants = { self: { _id: alice.pubkey }, peer: { _id: bob.pubkey } };

function database(sqlite: Database) {
  initializeTestDatabase(sqlite);
  return drizzle(sqlite, { schema });
}

function arrival(id: string) {
  return {
    id,
    eventId: id,
    peerKey,
    direction: "incoming" as const,
    body: "",
    senderKey: bob.pubkey,
    recipientKey: alice.pubkey,
    replyTo: null,
    sentAt: roundTime - 5_000,
    timeLock: historical,
  };
}

test("queues special and standard messages together and wraps only ciphertext for both identities", async () => {
  using sqlite = new Database(":memory:");
  const chat = createMessagingRepository(database(sqlite));
  const runtime = createMessagingService({
    signer: alice,
    chat,
    readState: () => null,
    writeState: () => {},
    createId: () => crypto.randomUUID(),
  });
  runtime.setUnlockActive(true);
  try {
    const quoteId = await runtime.send({
      peerKey,
      body: "ordinary message",
      replyTo: null,
    });
    const secret = "界".repeat(4_000);
    chat.saveDraft(peerKey, secret, quoteId);
    const id = await runtime.send({
      peerKey,
      body: secret,
      replyTo: quoteId,
      unlockAt: Date.now() + 60_000,
    });
    expect(chat.draft(peerKey)).toMatchObject({
      draft: "",
      draftReplyTo: null,
    });
    const row = chat.pending().find((item) => item.id === id);
    expect(row?.body).toBe("");
    expect(row?.rumorJson).not.toContain("界");
    const rumor = parseRumor(JSON.parse(row?.rumorJson ?? "null"));
    if (!rumor) throw new Error("Missing outgoing rumor");
    expect(rumor.kind).toBe(timeLockKind);
    const quoteEventId = chat.message(peerKey, quoteId)?.eventId;
    if (!quoteEventId) throw new Error("Missing quoted event");
    expect(rumor.tags).toContainEqual(["e", quoteEventId]);
    for (const recipient of [alice, bob]) {
      const wrap = await wrapRumor(ndk, rumor, recipient.pubkey, alice);
      expect(JSON.stringify(wrap.rawEvent()).length).toBeLessThan(
        maxTimeLockEnvelope,
      );
      const event = await unwrapPrivateEvent(wrap.rawEvent(), recipient);
      expect(event).toMatchObject({ type: "timelock", id: rumor.id });
      expect(JSON.stringify(event)).not.toContain("界");
    }
  } finally {
    runtime.setUnlockActive(false);
    runtime.stop();
  }
});

test("retains order, unread state and replies across cache reload, and never requeues a committed unlock", async () => {
  using sqlite = new Database(":memory:");
  const db = database(sqlite);
  const chat = createMessagingRepository(db);
  chat.receive(arrival("older"));
  expect(chat.receive({ ...arrival("older"), id: "duplicate-wrap" })).toBe(
    false,
  );
  expect(chat.conversation(peerKey)).toMatchObject({
    preview: "",
    lockedUntil: roundTime,
    unread: 1,
  });
  const translations = createTranslationCache(db);
  expect(translations.matchesIncoming("older", "")).toBe(false);
  chat.markRead(peerKey, ["older"]);
  expect(chat.unreadCount()).toBe(1);
  chat.receive({
    ...arrival("reply"),
    timeLock: undefined,
    body: "My reply",
    replyTo: "older",
    sentAt: roundTime + 4_000,
  });
  const initial = createMessagingRepository(db);
  const before = initial.history(peerKey).messages;
  expect(before[0]).toMatchObject({
    id: "older",
    body: "",
    locked: { requestedAt: roundTime },
  });
  const reply = before[1];
  if (!reply) throw new Error("Missing reply");
  expect(
    toDetailMessage(reply, before[0], participants, "Missing", "Locked message")
      .replyMessage,
  ).toMatchObject({ _id: "older", text: "Locked message" });

  const [job] = initial.dueUnlocks(Date.now());
  if (!job) throw new Error("Missing pending unlock");
  const opened = await createTimeLockOpener(
    undefined,
    async () => beacon,
  )(job.content);
  if (opened === null) throw new Error("Open failed");
  initial.commitUnlock(job, opened, Date.now());
  initial.commitUnlock(job, "stale", Date.now());
  using reopenedSqlite = Database.deserialize(sqlite.serialize());
  const reopenedDb = drizzle(reopenedSqlite, { schema });
  const reopened = createMessagingRepository(reopenedDb);
  expect(reopened.nextUnlock()).toBeNull();
  expect(
    createTranslationCache(reopenedDb).matchesIncoming("older", body),
  ).toBe(true);
  const after = reopened.history(peerKey).messages;
  expect(after.map(({ id, body }) => [id, body])).toEqual([
    ["older", body],
    ["reply", "My reply"],
  ]);
  expect(
    toDetailMessage(reply, after[0], participants, "Missing").replyMessage,
  ).toMatchObject({ _id: "older", text: body });
  expect(reopened.unreadCount()).toBe(2);
  reopened.markRead(peerKey, ["older"]);
  expect(reopened.unreadCount()).toBe(1);
  expect(
    sqlite.query("SELECT ciphertext FROM message_timelocks").get(),
  ).toEqual({ ciphertext });
});

test("backgrounds a shared worker and ignores a result for a deleted message", async () => {
  using sqlite = new Database(":memory:");
  const chat = createMessagingRepository(database(sqlite));
  let unblock: (() => void) | undefined;
  let started: (() => void) | undefined;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const scheduler = createUnlockScheduler(chat, async () => {
    started?.();
    await blocked;
    return body;
  });
  const incoming = arrival("late");
  chat.receive(incoming);
  scheduler.setActive(true);
  try {
    await began;
    chat.deleteMessages(peerKey, [incoming.id]);
    expect(chat.receive({ ...incoming, id: "same-rumor" })).toBe(false);
    scheduler.setActive(false);
    unblock?.();
    await Bun.sleep(25);
    expect(chat.history(peerKey).messages).toEqual([]);
    expect(chat.nextUnlock()).toBeNull();
    expect(chat.unreadCount()).toBe(0);
  } finally {
    scheduler.setActive(false);
  }
});
