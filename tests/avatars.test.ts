import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { sanitizeAvatarJpeg } from "../src/core/avatars/jpeg";
import {
  parseProfile,
  publicImageUrl,
  replaces,
  type ProfilePhotoPolicy,
} from "../src/core/avatars/protocol";
import { createAvatars, type AvatarDisk } from "../src/core/avatars/service";
import migrations from "../src/db/migrations/bundle";
import { saveContact, setPreference } from "../src/db/queries";
import * as schema from "../src/db/schema";

const secret = generateSecretKey();
const key = getPublicKey(secret);
const owner = getPublicKey(generateSecretKey());
const time = Math.floor(Date.now() / 1000);
const url = "https://photos.example.com/person.jpg";
const sign = (content: string, created_at = time) =>
  finalizeEvent({ kind: 0, content, tags: [], created_at }, secret);
const signed = (picture = url, created_at = time) =>
  sign(JSON.stringify({ name: "Public", picture }), created_at);

test("signed profiles validate metadata and apply Nostr replaceable ordering", () => {
  const first = signed();
  const parsed = parseProfile(first, key);
  expect(parsed?.picture).toBe(url);
  expect(parseProfile({ ...first, sig: "0".repeat(128) }, key)).toBeNull();
  expect(parseProfile(first, owner)).toBeNull();
  expect(parseProfile(sign("["), key)).toBeNull();
  expect(
    parseProfile(sign(JSON.stringify({ about: "a".repeat(17_000) })), key),
  ).toBeNull();
  expect(
    parseProfile(signed("https://127.0.0.1/avatar.jpg"), key)?.picture,
  ).toBeNull();
  expect(
    parseProfile(sign('{"display_name":"Boop"}'), key)?.picture,
  ).toBeNull();
  if (!parsed) throw new Error("Missing profile");
  expect(replaces({ eventId: "a", createdAt: time + 1 }, parsed)).toBe(true);
  expect(replaces({ eventId: "a", createdAt: time - 1 }, parsed)).toBe(false);
  expect(replaces(parsed, parsed)).toBe(false);
  expect(
    replaces(
      { eventId: "a", createdAt: time },
      { eventId: "b", createdAt: time },
    ),
  ).toBe(true);
});

test("unsafe URL shapes are excluded before transport", () => {
  for (const url of [
    "file:///tmp/photo.jpg",
    "data:image/png;base64,A",
    "http://photos.example.com/a",
    "https://user@photos.example.com/a",
    "https://[::1]/a",
    "https://0x7f000001/a",
    "https://foo.local/a",
    "https://10.1.1.2/a",
    "https://photos.example.com:8443/a",
  ]) {
    expect(publicImageUrl(url)).toBeNull();
  }
});

test("JPEG export removes APP markers, comments and trailing source bytes", () => {
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe1, 0, 8, 69, 120, 105, 102, 0, 0, 0xff, 0xfe, 0, 4, 71,
    80, 0xff, 0xc0, 0, 8, 8, 0, 2, 0, 2, 0, 0xff, 0xda, 0, 2, 80, 0xff, 0, 80,
    0xff, 0xd9, 1, 2, 3,
  ]);
  const result = sanitizeAvatarJpeg(jpeg);
  expect(result.dimension).toBe(2);
  expect([...result.bytes]).toEqual([
    0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 2, 0, 2, 0, 0xff, 0xda, 0, 2, 80, 0xff,
    0, 80, 0xff, 0xd9,
  ]);
  expect(() => sanitizeAvatarJpeg(jpeg.slice(0, -5))).toThrow();
});

function fixture(
  policy: ProfilePhotoPolicy,
  contact: boolean,
  blocked = false,
) {
  const sqlite = new Database(":memory:");
  for (const migration of Object.values(migrations.migrations))
    sqlite.exec(migration);
  const db = drizzle(sqlite, { schema });
  setPreference(db, "identity.publicKey", owner);
  if (contact) saveContact(db, key, "My Name");
  const context = { policy, blocked };
  const cache = new Set<string>();
  const local = new Set<string>();
  const disk: AvatarDisk = {
    newId: randomUUID,
    cacheTarget: (name) => name,
    cached: (name) => (cache.has(name) ? `file:///cache/${name}` : undefined),
    local: (name) => (local.has(name) ? `file:///local/${name}` : undefined),
    copyLocal: (_source, name) => {
      local.add(name);
    },
    removeCached: (name) => {
      cache.delete(name);
    },
    removeLocal: (name) => {
      local.delete(name);
    },
    clearCache: () => cache.clear(),
    sweep: () => {},
  };
  const requests: {
    id: string;
    name: string;
    url: string;
    finish: (size: number) => void;
  }[] = [];
  const cancelled: string[] = [];
  const avatars = createAvatars(
    db,
    owner,
    {
      photoPolicy: () => context.policy,
      isBlocked: () => context.blocked,
      isContact: (key) =>
        Boolean(
          db
            .select()
            .from(schema.contacts)
            .where(eq(schema.contacts.publicKey, key))
            .get(),
        ),
    },
    { watchProfiles: () => null },
    disk,
    {
      download: (id, url, name) =>
        new Promise((resolve) => {
          requests.push({
            id,
            url,
            name,
            finish(size) {
              cache.add(name);
              resolve(size);
            },
          });
        }),
      cancel(id) {
        cancelled.push(id);
      },
    },
  );
  avatars.setActive(true);
  avatars.ingest(signed(), key);
  function close() {
    avatars.setActive(false);
    sqlite.close();
  }
  return { context, db, avatars, requests, cancelled, close };
}

const matrix = [
  ["everyone", true, false, true, "contact"],
  ["everyone", false, false, true, "caller"],
  ["everyone", false, false, true, "message request"],
  ["contacts", true, false, true, "contact"],
  ["contacts", false, false, false, "caller"],
  ["contacts", false, false, false, "message sender"],
  ["nobody", true, false, false, "contact"],
  ["nobody", false, false, false, "unknown"],
  ["everyone", true, true, false, "blocked contact"],
] as const;

for (const [policy, contact, blocked, allowed, role] of matrix) {
  test(`${policy} policy controls HTTP dispatch for ${role}`, async () => {
    const f = fixture(policy, contact, blocked);
    try {
      const one = f.avatars.watch(key);
      const two = f.avatars.watch(key);
      await Bun.sleep(150);
      expect(f.requests.map((request) => request.url)).toEqual(
        allowed ? [url] : [],
      );
      if (allowed) {
        f.requests[0]?.finish(1000);
        await Bun.sleep(0);
        expect(f.avatars.resolve(key)).toStartWith("file:///cache/");
      } else expect(f.avatars.resolve(key)).toBeUndefined();
      two();
      one();
    } finally {
      f.close();
    }
  });
}

test("a local override works under Nobody with zero image requests", async () => {
  const f = fixture("nobody", true);
  try {
    f.avatars.saveOverride(key, "file:///test.jpg");
    f.avatars.watch(key);
    await Bun.sleep(150);
    expect(f.avatars.resolve(key)).toStartWith("file:///local/");
    expect(f.requests).toHaveLength(0);
    expect(f.db.select().from(schema.contacts).get()?.name).toBe("My Name");
    f.avatars.clear();
    expect(f.avatars.resolve(key)).toStartWith("file:///local/");
  } finally {
    f.close();
  }
});

for (const change of ["policy", "block", "delete", "identity"] as const) {
  test(`${change} during download cancels and discards the late result`, async () => {
    const f = fixture("contacts", true);
    try {
      f.avatars.watch(key);
      await Bun.sleep(150);
      const first = f.requests[0];
      if (!first) throw new Error("Missing request");
      if (change === "policy") f.context.policy = "nobody";
      if (change === "block") f.context.blocked = true;
      if (change === "delete") f.db.delete(schema.contacts).run();
      if (change === "identity") setPreference(f.db, "identity.publicKey", key);
      f.avatars.invalidate();
      expect(f.cancelled).toEqual([first.id]);
      first.finish(1024);
      await Bun.sleep(150);
      expect(f.requests).toHaveLength(1);
      expect(f.avatars.resolve(key)).toBeUndefined();
      expect(f.db.select().from(schema.avatarCache).all()).toEqual([]);
    } finally {
      f.close();
    }
  });
}

test("cache hides immediately on policy change; replacement waits for validated bytes", async () => {
  const f = fixture("contacts", true);
  try {
    await Bun.sleep(120);
    expect(f.requests).toHaveLength(0); // Metadata ingestion alone never requests an image.
    f.avatars.watch(key);
    await Bun.sleep(150);
    f.requests[0]?.finish(1024);
    await Bun.sleep(0);
    const first = f.avatars.resolve(key);
    expect(first).toStartWith("file:///cache/");
    f.context.policy = "nobody";
    f.avatars.invalidate();
    expect(f.avatars.resolve(key)).toBeUndefined();
    f.context.policy = "contacts";
    f.avatars.invalidate();
    expect(f.avatars.resolve(key)).toBe(first);
    f.avatars.ingest(
      signed("https://photos.example.com/replacement.jpg", time + 1),
      key,
    );
    await Bun.sleep(150);
    expect(f.requests).toHaveLength(2);
    expect(f.avatars.resolve(key)).toBe(first);
    f.requests[1]?.finish(1024);
    await Bun.sleep(0);
    expect(f.avatars.resolve(key)).not.toBe(first);
    f.avatars.ingest(signed(), key);
    expect(f.avatars.profile(key)?.picture).toBe(
      "https://photos.example.com/replacement.jpg",
    );
  } finally {
    f.close();
  }
});
