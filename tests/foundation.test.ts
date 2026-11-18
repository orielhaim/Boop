import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getExactRoutes } from "expo-router/build/getRoutes";
import { finalizeEvent } from "nostr-tools/pure";
import { CallSession } from "../src/core/calling/lifecycle";
import {
  type CallInvitation,
  IncomingInvitations,
  type PeerChallenge,
  verifyPeerProof,
} from "../src/core/calling/protocol";
import {
  missingTrysteroCapabilities,
  type PendingCallPeer,
  trysteroTransport,
} from "../src/core/calling/transport";
import {
  deriveIdentity,
  loadIdentity,
  parsePublicKey,
} from "../src/core/identity/keys";
import { relayUrl } from "../src/core/nostr/relays";
import { createMessagingRepository } from "../src/db/messaging";
import migrations from "../src/db/migrations/bundle";
import { callList, preference, setPreference } from "../src/db/queries";
import * as schema from "../src/db/schema";

const secret = "01".repeat(32);
const bytes = new Uint8Array(32).fill(1);
const peerKey = deriveIdentity(secret).publicKey;
const localKey = deriveIdentity("02".repeat(32)).publicKey;
const callId = "ab".repeat(32);
const makeInvitation = (now: number): CallInvitation => ({
  callId,
  roomSecret: "cd".repeat(32),
  caller: peerKey,
  recipient: localKey,
  expiresAt: now + 30_000,
});

test("creates one identity and derives the same npub after restart", async () => {
  let stored: string | null = null;
  let writes = 0;
  const storage = {
    read: async () => stored,
    write: async (value: string) => {
      stored = value;
      writes++;
    },
  };
  const identity = await loadIdentity(storage, null, async () => bytes);
  expect(identity.npub).toBe(
    "npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78suk0wul",
  );
  expect(parsePublicKey(`nostr:${identity.npub}`)).toBe(peerKey);
  expect(
    await loadIdentity(storage, peerKey, async () => {
      throw new Error("unexpected entropy");
    }),
  ).toEqual(identity);
  expect(writes).toBe(1);
});

test("fails closed when the secure store is locked, missing or corrupted", async () => {
  let writes = 0;
  const write = async () => {
    writes++;
  };
  const random = async () => bytes;
  await expect(
    loadIdentity(
      {
        read: async () => {
          throw new Error("locked");
        },
        write,
      },
      null,
      random,
    ),
  ).rejects.toThrow("locked");
  await expect(
    loadIdentity({ read: async () => null, write }, peerKey, random),
  ).rejects.toThrow("missing");
  await expect(
    loadIdentity({ read: async () => "broken", write }, peerKey, random),
  ).rejects.toThrow("Invalid");
  await expect(
    loadIdentity({ read: async () => secret, write }, localKey, random),
  ).rejects.toThrow("mismatch");
  expect(writes).toBe(0);
});

test("migration creates the app tables and enforces event and contact uniqueness", () => {
  using db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of Object.values(migrations.migrations))
    db.exec(migration);
  expect(
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .values()
      .flat(),
  ).toEqual([
    "call_history",
    "contacts",
    "conversations",
    "message_reactions",
    "messages",
    "relay_settings",
    "settings",
  ]);
  db.run("INSERT INTO contacts (public_key, name) VALUES (?, 'Alice')", [
    peerKey,
  ]);
  expect(() =>
    db.run("INSERT INTO contacts (public_key, name) VALUES (?, 'Duplicate')", [
      peerKey,
    ]),
  ).toThrow("UNIQUE");
  db.run("INSERT INTO conversations (peer_key, updated_at) VALUES (?, 1)", [
    peerKey,
  ]);
  db.run(
    "INSERT INTO messages (id, event_id, peer_key, direction, body, sent_at) VALUES ('1', 'event', ?, 'incoming', 'Hello', 1)",
    [peerKey],
  );
  expect(() =>
    db.run(
      "INSERT INTO messages (id, event_id, peer_key, direction, body, sent_at) VALUES ('2', 'event', ?, 'incoming', 'Hello', 1)",
      [peerKey],
    ),
  ).toThrow("UNIQUE");
  expect(() =>
    db.run(
      "INSERT INTO messages (id, peer_key, direction, body, sent_at) VALUES ('3', ?, 'outgoing', 'Hi', 1)",
      [localKey],
    ),
  ).toThrow("FOREIGN KEY");
});

test("queries local call history, conversation previews, drafts and preferences", () => {
  using sqlite = new Database(":memory:");
  for (const migration of Object.values(migrations.migrations))
    sqlite.exec(migration);
  const db = drizzle(sqlite, { schema });
  const repo = createMessagingRepository(db);
  db.insert(schema.contacts)
    .values({ publicKey: peerKey, name: "Alice" })
    .run();
  repo.saveDraft(peerKey, "Meet at six?", null);
  repo.receive({
    id: "message-1",
    eventId: "rumor-1",
    peerKey,
    direction: "incoming",
    body: "Hello",
    sentAt: 100,
    replyTo: null,
    senderKey: peerKey,
    recipientKey: localKey,
  });
  db.insert(schema.callHistory)
    .values({
      id: "call-1",
      peerKey,
      direction: "incoming",
      outcome: "missed",
      startedAt: 100,
    })
    .run();
  expect(repo.conversation(peerKey)).toMatchObject({
    name: "Alice",
    preview: "Hello",
    draft: "Meet at six?",
    unread: 1,
  });
  expect(callList(db).all()[0]).toMatchObject({
    name: "Alice",
    outcome: "missed",
  });
  repo.markRead(peerKey);
  expect(repo.conversation(peerKey)?.unread).toBe(0);
  setPreference(db, "theme", "dark");
  expect(preference(db, "theme")).toBe("dark");
});

test("requires a timely invitation from the expected verified Nostr sender", () => {
  const now = 1_700_000_000_000;
  const invite = makeInvitation(now);
  const gate = new IncomingInvitations();
  expect(gate.accept(invite, peerKey, localKey, now)).toEqual(invite);
  expect(gate.accept(invite, peerKey, localKey, now + 1)).toBeNull();
  expect(gate.accept(invite, localKey, peerKey, now)).toBeNull();
  expect(gate.accept(invite, peerKey, localKey, invite.expiresAt)).toBeNull();
  expect(
    gate.accept({ ...invite, expiresAt: now + 60_001 }, peerKey, localKey, now),
  ).toBeNull();
  expect(relayUrl.safeParse("ws://relay.example").success).toBe(false);
  expect(relayUrl.safeParse("").success).toBe(false);
  expect(relayUrl.safeParse("relay.example").success).toBe(false);
  expect(relayUrl.safeParse("wss://name:password@relay.example").success).toBe(
    false,
  );
});

test("Expo Router discovers three primary tabs and the detail routes", () => {
  const context = Object.assign(() => ({}), {
    keys: () =>
      Array.from(
        new Bun.Glob("**/*.tsx").scanSync({
          cwd: fileURLToPath(new URL("../src/app", import.meta.url)),
        }),
        (path) => `./${path.replaceAll("\\", "/")}`,
      ),
    id: "boop-routes",
    resolve: (path: string) => path,
  });
  const root = getExactRoutes(context, { importMode: "lazy" });
  expect(root?.children.map((route) => route.route).sort()).toEqual([
    "(tabs)",
    "call/[key]",
    "chat/[key]",
    "connect",
    "contact/[key]",
    "contact/new",
    "scan",
    "settings/index",
  ]);
  expect(
    root?.children
      .find((route) => route.route === "(tabs)")
      ?.children.map((route) => route.route)
      .sort(),
  ).toEqual(["contacts", "index", "messages"]);
});

function signProof(challenge: PeerChallenge, timestamp: number) {
  return finalizeEvent(
    {
      kind: 20058,
      created_at: timestamp,
      tags: [],
      content: JSON.stringify([
        "boop-call-proof-v1",
        challenge.callId,
        challenge.challenge,
        challenge.remotePeerId,
        challenge.localPeerId,
        challenge.expectedKey,
        challenge.localKey,
      ]),
    },
    bytes,
  );
}

test("binds a verified proof to its call, challenge and both peer IDs", () => {
  const now = 1_700_000_000;
  const challenge = {
    callId,
    challenge: "aa".repeat(32),
    remotePeerId: "peer-a",
    localPeerId: "peer-b",
    expectedKey: peerKey,
    localKey,
  };
  const proof = signProof(challenge, now);
  expect(verifyPeerProof(proof, challenge, now)).toBe(true);
  expect(
    verifyPeerProof(proof, { ...challenge, remotePeerId: "peer-c" }, now),
  ).toBe(false);
  expect(
    verifyPeerProof(proof, { ...challenge, challenge: "bb".repeat(32) }, now),
  ).toBe(false);
  expect(
    verifyPeerProof({ ...proof, sig: "00".repeat(64) }, challenge, now),
  ).toBe(false);
});

test("never starts audio before proof and releases resources on failure", async () => {
  const events: string[] = [];
  const peer: PendingCallPeer = {
    remotePeerId: "rtc-a",
    localPeerId: "rtc-b",
    async prove() {
      events.push("proof");
      return {};
    },
    async startAudio() {
      events.push("audio");
    },
    onDisconnect() {
      return () => {
        events.push("unsubscribe");
      };
    },
    setMuted() {},
    setSpeaker() {},
    close() {
      events.push("close");
    },
  };
  const session = new CallSession((state) => events.push(state.phase));
  session.start("incoming");
  await session.accept(
    { connect: async () => peer },
    makeInvitation(Date.now()),
    localKey,
    peerKey,
    async () => "aa".repeat(32),
  );
  session.finish();
  expect(events).toEqual([
    "incoming",
    "ringing",
    "connecting",
    "proof",
    "unsubscribe",
    "close",
    "failed",
  ]);
});

test("a verified peer opens audio and disconnect closes the connection once", async () => {
  const events: string[] = [];
  let disconnect: (() => void) | undefined;
  const peer: PendingCallPeer = {
    remotePeerId: "rtc-a",
    localPeerId: "rtc-b",
    async prove(challenge) {
      events.push("proof");
      return signProof(challenge, Math.floor(Date.now() / 1000));
    },
    async startAudio() {
      events.push("audio");
    },
    onDisconnect(listener) {
      disconnect = listener;
      return () => {
        events.push("unsubscribe");
      };
    },
    setMuted(muted) {
      events.push(String(muted));
    },
    setSpeaker() {},
    close() {
      events.push("close");
    },
  };
  const session = new CallSession((state) => events.push(state.phase));
  session.start("incoming");
  await session.accept(
    { connect: async () => peer },
    makeInvitation(Date.now()),
    localKey,
    peerKey,
    async () => "aa".repeat(32),
  );
  session.mute(true);
  disconnect?.();
  session.finish();
  expect(events).toEqual([
    "incoming",
    "ringing",
    "connecting",
    "proof",
    "audio",
    "active",
    "true",
    "unsubscribe",
    "close",
    "ended",
  ]);
});

test("unconfigured transport rejects connection and reports missing RN capabilities", async () => {
  const now = Date.now();
  await expect(
    trysteroTransport.connect(
      makeInvitation(now),
      new AbortController().signal,
    ),
  ).rejects.toThrow("unavailable");
  expect(
    missingTrysteroCapabilities({
      crypto: { getRandomValues() {} },
      RTCPeerConnection() {},
    }),
  ).toContain("WebCrypto SubtleCrypto");
});
