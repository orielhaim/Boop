import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import baseline from "../src/db/migrations/bundle";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getExactRoutes } from "expo-router/build/getRoutes";
import { deriveIdentity } from "../src/core/identity/keys";
import { configuredRelays, inboxIntentKey } from "../src/core/nostr/config";
import { relayUrl } from "../src/core/nostr/relays";
import { initializeTestDatabase } from "./db-fixture";
import { callList, preference, setPreference } from "../src/db/queries";
import { editRelays, seedRelays } from "../src/db/relays";
import * as schema from "../src/db/schema";

const secret = "01".repeat(32);
const peerKey = deriveIdentity(secret).publicKey;
const localKey = deriveIdentity("02".repeat(32)).publicKey;
test("fresh baseline keeps application state and enforces contact uniqueness", () => {
  using db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrationsFolder = join(import.meta.dir, "../src/db/migrations");
  expect(baseline.journal.entries.map(({ tag }) => tag)).toEqual([
    "0000_initial",
    "0001_speech_jobs",
    "0002_downloads",
  ]);
  expect(baseline.migrations.m0000).toBe(
    readFileSync(join(migrationsFolder, "0000_initial.sql"), "utf8"),
  );
  expect(baseline.migrations.m0001).toBe(
    readFileSync(join(migrationsFolder, "0001_speech_jobs.sql"), "utf8"),
  );
  expect(baseline.migrations.m0002).toBe(
    readFileSync(join(migrationsFolder, "0002_downloads.sql"), "utf8"),
  );
  const orm = drizzle(db, { schema });
  migrate(orm, { migrationsFolder });
  migrate(orm, { migrationsFolder });
  expect(db.query("PRAGMA user_version").values()).toEqual([[2]]);
  expect(
    db.query("SELECT count(*) FROM __drizzle_migrations").values(),
  ).toEqual([[3]]);
  expect(
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> '__drizzle_migrations' ORDER BY name",
      )
      .values()
      .flat(),
  ).toEqual([
    "avatar_cache",
    "call_history",
    "contacts",
    "downloads",
    "link_preview_cache",
    "nostr_profiles",
    "peer_permissions",
    "relay_settings",
    "settings",
    "speech_jobs",
  ]);
  db.run("INSERT INTO contacts (public_key, name) VALUES (?, 'Alice')", [
    peerKey,
  ]);
  expect(() =>
    db.run("INSERT INTO contacts (public_key, name) VALUES (?, 'Duplicate')", [
      peerKey,
    ]),
  ).toThrow("UNIQUE");
});

test("queries local call history and preferences", () => {
  using sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  db.insert(schema.contacts)
    .values({ publicKey: peerKey, name: "Alice" })
    .run();
  db.insert(schema.callHistory)
    .values({
      id: "call-1",
      peerKey,
      direction: "incoming",
      outcome: "missed",
      startedAt: 100,
    })
    .run();
  expect(callList(db).all()[0]).toMatchObject({
    name: "Alice",
    outcome: "missed",
  });
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
test("Expo Router discovers the primary routes including the optional Calls tab", () => {
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
    "(messenger)",
    "call/[key]",
    "scan",
  ]);
  const messenger = root?.children.find(
    (route) => route.route === "(messenger)",
  );
  expect(messenger?.children.map((route) => route.route).sort()).toEqual([
    "(tabs)",
    "add-contact",
    "audio-player",
    "chat/[key]",
    "connect",
    "downloads",
    "person/[key]",
    "profile-photo/[key]",
    "requests",
    "settings",
  ]);
  expect(
    messenger?.children
      .find((route) => route.route === "settings")
      ?.children.map((route) => route.route)
      .sort(),
  ).toEqual([
    "about",
    "appearance",
    "calls",
    "connections",
    "connections/media-storage",
    "edit-profile",
    "identity",
    "identity-keys",
    "identity/backup",
    "identity/devices",
    "index",
    "language",
    "language/translation/excluded",
    "language/translation/index",
    "language/translation/models",
    "language/translation/target",
    "language/voice-transcription/index",
    "language/voice-transcription/models",
    "playback",
    "privacy",
    "privacy/app-lock",
    "privacy/blocked",
    "privacy/incoming-video",
    "privacy/link-previews",
    "privacy/permissions",
    "privacy/profile-photos",
    "storage",
  ]);
  expect(
    messenger?.children
      .find((route) => route.route === "(tabs)")
      ?.children.map((route) => route.route)
      .sort(),
  ).toEqual(["calls", "index", "people", "profile"]);
});
