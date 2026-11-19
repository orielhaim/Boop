import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getExactRoutes } from "expo-router/build/getRoutes";
import {
  deriveIdentity,
  loadIdentity,
  parsePublicKey,
} from "../src/core/identity/keys";
import { configuredRelays, inboxIntentKey } from "../src/core/nostr/config";
import { relayUrl } from "../src/core/nostr/relays";
import { createMessagingRepository } from "../src/db/messaging";
import migrations from "../src/db/migrations/bundle";
import { callList, preference, setPreference } from "../src/db/queries";
import { editRelays, seedRelays } from "../src/db/relays";
import * as schema from "../src/db/schema";

const secret = "01".repeat(32);
const bytes = new Uint8Array(32).fill(1);
const peerKey = deriveIdentity(secret).publicKey;
const localKey = deriveIdentity("02".repeat(32)).publicKey;
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
    "blocked_identities",
    "call_history",
    "communication_grants",
    "contacts",
    "conversations",
    "message_reactions",
    "message_requests",
    "message_timelocks",
    "message_translations",
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
  repo.markRead(peerKey, ["message-1"]);
  expect(repo.conversation(peerKey)?.unread).toBe(0);
  setPreference(db, "theme", "dark");
  expect(preference(db, "theme")).toBe("dark");
});

test("seeds verified roles on a new identity and does not reseed after removal", () => {
  using sqlite = new Database(":memory:");
  for (const migration of Object.values(migrations.migrations))
    sqlite.exec(migration);
  const db = drizzle(sqlite, { schema });
  seedRelays(db, true);
  const saved = db.select().from(schema.relaySettings).all();
  expect(configuredRelays(saved, preference(db, inboxIntentKey))).toEqual({
    general: ["wss://nos.lol/", "wss://relay.primal.net/"],
    inbox: ["wss://nos.lol/", "wss://relay.primal.net/"],
    discovery: ["wss://purplepag.es/"],
    intent: "initial",
  });
  editRelays(
    db,
    saved.map(({ url }) => ({ url, next: null })),
    "explicit-removal",
  );
  seedRelays(db, false);
  expect(db.select().from(schema.relaySettings).all()).toEqual([]);
  expect(preference(db, inboxIntentKey)).toBe("explicit-removal");
});

test("migrates a disabled custom relay without replacing it or its publication policy", () => {
  using sqlite = new Database(":memory:");
  const steps = Object.values(migrations.migrations);
  for (const migration of steps.slice(0, -1)) sqlite.exec(migration);
  sqlite.run(
    "insert into relay_settings (url, enabled) values ('wss://custom.example/', 0)",
  );
  const current = steps.at(-1);
  if (!current) throw new Error("Missing relay migration");
  sqlite.exec(current);
  const db = drizzle(sqlite, { schema });
  seedRelays(db, false);
  expect(db.select().from(schema.relaySettings).all()).toEqual([
    {
      url: "wss://custom.example/",
      enabled: false,
      general: true,
      inbox: true,
      discovery: false,
    },
  ]);
  expect(preference(db, inboxIntentKey)).toBeNull();
});

test("requires a secure relay URL", () => {
  for (const invalid of [
    "",
    "relay.example",
    "ws://relay.example",
    "wss://user:password@relay.example",
    "wss:relay.example",
  ]) {
    expect(relayUrl.safeParse(invalid).success).toBe(false);
  }
});
test("Expo Router discovers four primary tabs and the detail routes", () => {
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
    "requests",
    "requests/[key]",
    "scan",
    "settings",
  ]);
  expect(
    root?.children
      .find((route) => route.route === "settings")
      ?.children.map((route) => route.route)
      .sort(),
  ).toEqual([
    "about",
    "appearance",
    "calls",
    "chats",
    "chats/models",
    "chats/target",
    "chats/translation",
    "connections",
    "identity",
    "language",
    "privacy",
    "privacy/app-lock",
    "privacy/blocked",
    "privacy/incoming-video",
    "privacy/permissions",
    "sim",
  ]);
  expect(
    root?.children
      .find((route) => route.route === "(tabs)")
      ?.children.map((route) => route.route)
      .sort(),
  ).toEqual(["contacts", "index", "messages", "profile"]);
});
