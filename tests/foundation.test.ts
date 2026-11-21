import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import baseline from "../src/db/migrations/bundle";
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
import { initializeTestDatabase } from "./db-fixture";
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

test("fresh baseline initializes once and enforces event and contact uniqueness", () => {
  using db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrationsFolder = join(import.meta.dir, "../src/db/migrations");
  expect(baseline.journal.entries.map(({ tag }) => tag)).toEqual([
    "0000_initial",
  ]);
  expect(baseline.migrations.m0000).toBe(
    readFileSync(join(migrationsFolder, "0000_initial.sql"), "utf8"),
  );
  const orm = drizzle(db, { schema });
  migrate(orm, { migrationsFolder });
  migrate(orm, { migrationsFolder });
  expect(db.query("PRAGMA user_version").values()).toEqual([[1]]);
  expect(
    db.query("SELECT count(*) FROM __drizzle_migrations").values(),
  ).toEqual([[1]]);
  expect(
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> '__drizzle_migrations' ORDER BY name",
      )
      .values()
      .flat(),
  ).toEqual([
    "attachment_cache",
    "attachment_uploads",
    "avatar_cache",
    "call_history",
    "contacts",
    "conversations",
    "link_preview_cache",
    "message_attachments",
    "message_edit_outbox",
    "message_reactions",
    "message_requests",
    "message_revisions",
    "message_timelocks",
    "message_translations",
    "messages",
    "nostr_profiles",
    "peer_permissions",
    "pending_message_edits",
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
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
});

test("chat reads use the targeted partial indexes", () => {
  using sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
  const queries = {
    message_attachments_hash:
      "SELECT message_id FROM message_attachments WHERE hash = 'digest'",
    messages_peer_order:
      "SELECT * FROM messages WHERE peer_key = 'peer' AND deleted_at IS NULL AND (sent_at, id) < (10, 'id') ORDER BY sent_at DESC, id DESC LIMIT 50",
    messages_unread:
      "SELECT count(*) FROM messages WHERE peer_key = 'peer' AND deleted_at IS NULL AND is_unread = 1",
    messages_pinned:
      "SELECT * FROM messages WHERE peer_key = 'peer' AND deleted_at IS NULL AND pinned_at IS NOT NULL ORDER BY pinned_at DESC, id DESC",
    messages_outbox:
      "SELECT * FROM messages WHERE status = 'pending' AND deleted_at IS NULL ORDER BY sent_at, id LIMIT 25",
    messages_attachment_copies:
      "SELECT * FROM messages WHERE status = 'sent' AND content_type = 'attachment' AND deleted_at IS NULL AND rumor_json IS NOT NULL ORDER BY sent_at, id LIMIT 16",
  };
  for (const [index, query] of Object.entries(queries)) {
    const plan = sqlite
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${query}`)
      .all();
    expect(plan.some(({ detail }) => detail.includes(index))).toBe(true);
    expect(plan.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(
      false,
    );
  }
});

test("queries local call history, conversation previews, drafts and preferences", () => {
  using sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
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
  initializeTestDatabase(sqlite);
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
    "chats/media",
    "chats/models",
    "chats/target",
    "chats/translation",
    "connections",
    "connections/media-storage",
    "identity",
    "identity/edit-profile",
    "language",
    "privacy",
    "privacy/app-lock",
    "privacy/blocked",
    "privacy/incoming-video",
    "privacy/link-previews",
    "privacy/permissions",
    "privacy/profile-photos",
    "sim",
  ]);
  expect(
    root?.children
      .find((route) => route.route === "(tabs)")
      ?.children.map((route) => route.route)
      .sort(),
  ).toEqual(["contacts", "index", "messages", "profile"]);
});
