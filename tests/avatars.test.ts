import type { MarmotPublicProfile } from "../src/core/marmot/native";
import { createProfileDirectory } from "../src/core/profiles/directory";
import { publicMediaUrl as publicImageUrl } from "../src/core/media/url";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { sanitizeAvatarJpeg } from "../src/core/avatars/jpeg";
import { type ProfilePhotoPolicy } from "../src/core/avatars/protocol";
import { createAvatars, type AvatarDisk } from "../src/core/avatars/service";
import { initializeTestDatabase } from "./db-fixture";
import { saveContact, setPreference } from "../src/db/queries";
import * as schema from "../src/db/schema";

const secret = generateSecretKey();
const key = getPublicKey(secret);
const owner = getPublicKey(generateSecretKey());
const url = "https://photos.example.com/person.jpg";

function photo(picture: string): MarmotPublicProfile {
  return {
    key,
    picture,
    name: undefined,
    displayName: "Boop",
    about: undefined,
    banner: undefined,
    nip05: undefined,
    lud16: undefined,
    website: undefined,
    bot: false,
  };
}

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

test("JPEG export replaces source metadata with a fixed JFIF header", () => {
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe1, 0, 8, 69, 120, 105, 102, 0, 0, 0xff, 0xfe, 0, 4, 71,
    80, 0xff, 0xc0, 0, 8, 8, 0, 2, 0, 2, 0, 0xff, 0xda, 0, 2, 80, 0xff, 0, 80,
    0xff, 0xd9, 1, 2, 3,
  ]);
  const result = sanitizeAvatarJpeg(jpeg);
  expect(result.dimension).toBe(2);
  expect([...result.bytes]).toEqual([
    0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0, 8, 8, 0, 2, 0, 2, 0, 0xff, 0xda, 0, 2, 80, 0xff, 0, 80, 0xff,
    0xd9,
  ]);
  expect(sanitizeAvatarJpeg(result.bytes).bytes).toEqual(result.bytes);
  expect(() => sanitizeAvatarJpeg(jpeg.slice(0, -5))).toThrow();
});

function fixture(
  policy: ProfilePhotoPolicy,
  contact: boolean,
  blocked = false,
) {
  const sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  if (contact) saveContact(db, key, "My Name");
  const context = { policy, blocked };
  const cache = new Set<string>();
  const local = new Set<string>();
  const authored = new Map<string, string>();
  const disk: AvatarDisk = {
    newId: randomUUID,
    cacheTarget: (name) => name,
    cached: (name) => (cache.has(name) ? `file:///cache/${name}` : undefined),
    local: (name) => (local.has(name) ? `file:///local/${name}` : undefined),
    copyLocal: (_source, name) => {
      local.add(name);
    },
    authored(field, name) {
      const retained = authored.get(field);
      return retained === name
        ? `file:///local/${field}-${retained}`
        : undefined;
    },
    keepAuthored(field, file, name) {
      if (file && name) authored.set(field, name);
      else authored.delete(field);
    },
    commitCached(staged, name) {
      cache.delete(staged);
      cache.add(name);
    },
    removeCached: (name) => {
      cache.delete(name);
    },
    removeLocal: (name) => {
      local.delete(name);
    },
    clearCache: () => cache.clear(),
    sweepLocal: () => {},
    pruneCache: () => {},
  };
  const requests: {
    id: string;
    name: string;
    url: string;
    finish: (size: number) => void;
  }[] = [];
  const cancelled: string[] = [];
  let current = true;
  let projection = photo(url);
  const profiles = createProfileDirectory(
    { read: async () => [projection], refresh: async () => {} },
    () => current,
    () => context.blocked,
    () => [],
  );
  profiles.setActive(true);
  profiles.read([key]);
  const openAvatars = (directory = profiles) =>
    createAvatars(
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
      directory,
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
      undefined,
      () => current,
      () => [],
    );
  const avatars = openAvatars();
  avatars.setActive(true);
  function close() {
    profiles.setActive(false);
    avatars.setActive(false);
    sqlite.close();
  }
  return {
    context,
    cache,
    profile(next: typeof projection) {
      projection = next;
      profiles.reload(next.key);
    },
    db,
    avatars,
    reopen: () => openAvatars({ ...profiles, profile: () => undefined }),
    requests,
    cancelled,
    close,
    retire: () => {
      current = false;
    },
  };
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

test("a profile refresh only notifies the rows for that person", async () => {
  const f = fixture("nobody", true);
  const stopWatching = f.avatars.watch(key);
  const stopBanner = f.avatars.watch(key, true);
  const updated: string[] = [];
  const stopUpdated = f.avatars.subscribe(key, () => updated.push(key));
  const untouched = Array.from({ length: 24 }, (_, index) =>
    (index + 1).toString(16).padStart(64, "0"),
  );
  const stops = untouched.map((peer) =>
    f.avatars.subscribe(peer, () => updated.push(peer)),
  );
  try {
    await Bun.sleep(0);
    updated.length = 0;
    f.profile(photo("https://photos.example.com/replacement.jpg"));
    await Bun.sleep(0);
    expect(updated).toEqual([key]);
  } finally {
    stops.forEach((stop) => stop());
    stopUpdated();
    stopBanner();
    stopWatching();
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
      if (change === "identity") f.retire();
      f.avatars.invalidate();
      expect(f.cancelled).toEqual([first.id]);
      first.finish(1024);
      await Bun.sleep(150);
      expect(f.requests).toHaveLength(1);
      expect(f.avatars.resolve(key)).toBeUndefined();
      expect([...f.cache]).toEqual([]);
    } finally {
      f.close();
    }
  });
}

test("validated avatar bytes remain visible when automatic downloads are disabled", async () => {
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
    expect(f.avatars.resolve(key)).toBe(first);
    await Bun.sleep(150);
    expect(f.requests).toHaveLength(1);
    f.context.policy = "contacts";
    f.avatars.invalidate();
    expect(f.avatars.resolve(key)).toBe(first);
    f.profile(photo("https://photos.example.com/replacement.jpg"));
    await Bun.sleep(150);
    expect(f.requests).toHaveLength(2);
    expect(f.avatars.resolve(key)).toBeUndefined();
    f.requests[1]?.finish(1024);
    await Bun.sleep(0);
    expect(f.avatars.resolve(key)).not.toBe(first);
  } finally {
    f.close();
  }
});

test("explicit photo and banner downloads finish after leaving and refresh on the next visit", async () => {
  const f = fixture("contacts", false);
  const banner = "https://photos.example.com/cover.jpg";
  try {
    f.profile({ ...photo(url), banner });
    const stopPhoto = f.avatars.watch(key, false, true);
    const stopBanner = f.avatars.watch(key, true, true);
    await Bun.sleep(150);
    expect(f.requests).toEqual([]);

    f.avatars.requestProfileImages(key);
    await Bun.sleep(150);
    expect(f.requests.map((request) => request.url).sort()).toEqual(
      [banner, url].sort(),
    );
    stopPhoto();
    stopBanner();
    expect(f.cancelled).toEqual([]);
    for (const request of f.requests) request.finish(12);
    await Bun.sleep(20);
    const firstPhoto = f.avatars.resolve(key);
    const firstBanner = f.avatars.resolve(key, true);
    expect(firstPhoto).toStartWith("file:///cache/");
    expect(firstBanner).toStartWith("file:///cache/");

    const reopened = f.reopen();
    expect(reopened.resolve(key)).toBe(firstPhoto);
    expect(reopened.resolve(key, true)).toBe(firstBanner);

    const nextPhoto = "https://photos.example.com/updated.jpg";
    const nextBanner = "https://photos.example.com/updated-cover.jpg";
    f.profile({ ...photo(nextPhoto), banner: nextBanner });
    expect(f.avatars.resolve(key)).toBe(firstPhoto);
    expect(f.avatars.resolve(key, true)).toBe(firstBanner);
    await Bun.sleep(150);
    expect(f.requests).toHaveLength(2);
    f.avatars.watch(key, false, true);
    f.avatars.watch(key, true, true);
    await Bun.sleep(150);
    expect(
      f.requests
        .slice(2)
        .map(({ url }) => url)
        .sort(),
    ).toEqual([nextPhoto, nextBanner].sort());
    for (const request of f.requests.slice(2)) request.finish(12);
    await Bun.sleep(20);
    expect(f.avatars.resolve(key)).not.toBe(firstPhoto);
    expect(f.avatars.resolve(key, true)).not.toBe(firstBanner);
    f.context.blocked = true;
    f.avatars.requestProfileImages(key);
    f.avatars.invalidate();
    await Bun.sleep(150);
    expect(f.requests).toHaveLength(4);
    expect(f.avatars.resolve(key)).toBeUndefined();
  } finally {
    f.close();
  }
});

test("an authored profile image survives clearing downloads without granting its URL network access", async () => {
  const f = fixture("nobody", false);
  try {
    f.profile({ ...photo(url), key: owner });
    f.avatars.watch(owner);
    f.avatars.keepUploaded("photo", "file.jpg", url);
    await Bun.sleep(150);
    const authored = f.avatars.resolve(owner);
    expect(authored).toStartWith("file:///local/photo-");
    f.avatars.clear();
    expect(f.avatars.resolve(owner)).toBe(authored);
    expect(f.requests).toEqual([]);
  } finally {
    f.close();
  }
});

test("a photo policy change revokes consent and cancels its in-flight download", async () => {
  const f = fixture("contacts", false);
  try {
    f.avatars.watch(key, false, true);
    f.avatars.requestProfileImages(key);
    await Bun.sleep(150);
    const request = f.requests[0];
    if (!request) throw new Error("Missing explicit request");
    f.context.policy = "nobody";
    f.avatars.invalidate();
    expect(f.cancelled).toEqual([request.id]);
    request.finish(200);
    await Bun.sleep(0);
    expect(f.avatars.resolve(key)).toBeUndefined();
    expect([...f.cache]).toEqual([]);
    f.context.policy = "contacts";
    f.avatars.invalidate();
    expect(f.avatars.profileImagesRequested(key)).toBe(false);
  } finally {
    f.close();
  }
});
