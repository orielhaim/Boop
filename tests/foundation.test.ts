import { getPublicKey } from "nostr-tools/pure";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getExactRoutes } from "expo-router/build/getRoutes";
import { relayUrl } from "../src/core/nostr/relays";
import { initializeTestDatabase } from "./db-fixture";
import { callList, preference, setPreference } from "../src/db/queries";
import * as schema from "../src/db/schema";

const secret = "01".repeat(32);
const peerKey = getPublicKey(Buffer.from(secret, "hex"));
const localKey = getPublicKey(Buffer.from("02".repeat(32), "hex"));
test("fresh baseline keeps application state and enforces contact uniqueness", () => {
  using db = new Database(":memory:");
  initializeTestDatabase(db);
  initializeTestDatabase(db);
  expect(db.query("PRAGMA user_version").values()).toEqual([[5]]);
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
    "call_history",
    "contacts",
    "downloads",
    "link_preview_cache",
    "peer_permissions",
    "settings",
    "speech_jobs",
    "torrent_cache",
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
    "dial-address",
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
    "incoming-file",
    "person/[key]",
    "profile-photo/[key]",
    "requests",
    "settings",
    "video-player",
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
    "plugins",
    "plugins/torrents",
    "privacy",
    "privacy/app-lock",
    "privacy/blocked",
    "privacy/incoming-calls",
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
