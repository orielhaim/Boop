import { expect, test } from "bun:test";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { verifyEvent } from "nostr-tools/pure";
import { cacheEvictions } from "../src/core/media/cache-policy";
import { createBlossomClient } from "../src/core/media/blossom";
import {
  createMediaSettings,
  parseServerOrigins,
} from "../src/core/media/servers";
import { createMediaUploads } from "../src/core/media/uploads";

const first = "https://first.example.com";
const second = "https://second.example.com";
const disabled = "https://disabled.example.com";
const foreign = "https://foreign.example.com";
const signer = NDKPrivateKeySigner.generate();
const bytes = Uint8Array.fromHex(
  "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919",
);
const sha256 = async (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const hash = await sha256(bytes);
const mime = "application/octet-stream";
const blob = {
  bytes,
  hash,
  mime: "application/octet-stream" as const,
  size: bytes.length,
};
const descriptor = (origin: string, overrides?: object) =>
  Response.json(
    {
      url: `${origin}/${hash}.bin`,
      sha256: hash,
      size: bytes.length,
      type: mime,
      uploaded: 1,
      ...overrides,
    },
    { status: 201 },
  );
const signal = () => new AbortController().signal;

function settingsFor(entries = new Map<string, string>()) {
  const store = {
    read(key: string) {
      return entries.get(key) ?? null;
    },
    write(key: string, value: string) {
      entries.set(key, value);
    },
  };
  return { store, settings: createMediaSettings(store) };
}

test("migrates profile server order, keeps the private role independent, and persists changes", () => {
  const { settings, store } = settingsFor(
    new Map([
      ["media.primary", first],
      ["media.backup", second],
      ["media.mirror", "true"],
    ]),
  );
  expect(settings.configured("profile").map((server) => server.origin)).toEqual(
    [first, second],
  );
  expect(
    settings.configured("attachment").map((server) => server.origin),
  ).toEqual(["https://nostr.download"]);
  expect(settings.snapshot().mirror).toBe(true);
  settings.save({ servers: [], mirror: false });
  const reopened = createMediaSettings(store);
  expect(reopened.snapshot()).toEqual({ servers: [], mirror: false });
  expect(
    parseServerOrigins([
      ["server", second],
      ["server", "http://unsafe.example.com"],
      ["server", first],
      ["server", second],
      ["e", foreign],
    ]),
  ).toEqual([second, first]);
});

test("a signed preflight sends only encrypted metadata and unsupported handlers fall through to PUT", async () => {
  const requests: string[] = [];
  const client = createBlossomClient(signer, {
    sha256,
    async request(path, options) {
      requests.push(`${options.method} ${path}`);
      expect(options.redirect).toBe("error");
      expect(options.credentials).toBe("omit");
      const auth = options.headers?.Authorization;
      if (!auth) throw new Error("Missing authorization");
      const event = JSON.parse(
        Buffer.from(auth.slice(6), "base64url").toString(),
      );
      expect(verifyEvent(event)).toBe(true);
      expect(event.tags).toContainEqual(["x", hash]);
      expect(event.tags).toContainEqual(["server", "first.example.com"]);
      if (options.method === "HEAD") {
        expect(options.body).toBeUndefined();
        expect(options.headers?.["X-Content-Type"]).toBe(mime);
        expect(options.headers?.["X-Content-Length"]).toBe(
          String(bytes.length),
        );
        return new Response(null, { status: 405 });
      }
      expect(options.body).toEqual(bytes);
      expect(options.headers?.["Content-Type"]).toBe(mime);
      return descriptor(first);
    },
  });
  expect(await client.put(first, blob, signal())).toBe(`${first}/${hash}.bin`);
  expect(requests).toEqual([`HEAD ${first}/upload`, `PUT ${first}/upload`]);
});

test("preflight rejections are typed and prevent sending bytes", async () => {
  for (const [status, code] of [
    [401, "authorization"],
    [402, "payment"],
    [403, "forbidden"],
    [409, "hash"],
    [413, "size"],
    [415, "format"],
    [429, "rate-limit"],
  ] as const) {
    const client = createBlossomClient(signer, {
      sha256,
      async request(_path, options) {
        expect(options.method).toBe("HEAD");
        return new Response(null, {
          status,
          headers: { "X-Reason": "Ignored" },
        });
      },
    });
    await expect(client.put(first, blob, signal())).rejects.toMatchObject({
      status,
      code,
    });
  }
});

test("only enabled, compatible role candidates receive a PUT, and MIME/size rejection stays local", async () => {
  const { settings } = settingsFor();
  settings.save({
    mirror: false,
    servers: [
      { origin: first, enabled: true, roles: ["attachment"] },
      { origin: second, enabled: true, roles: ["attachment", "profile"] },
      { origin: disabled, enabled: false, roles: ["attachment"] },
      { origin: foreign, enabled: true, roles: ["profile"] },
    ],
  });
  for (const rejection of [413, 415]) {
    const requests: string[] = [];
    const uploads = createMediaUploads(
      signer,
      {
        sha256,
        async request(path, options) {
          requests.push(`${options.method} ${path}`);
          if (path.startsWith(first))
            return new Response(null, { status: rejection });
          if (options.method === "HEAD")
            return new Response(null, { status: 200 });
          expect(path).toBe(`${second}/upload`);
          expect(options.body).toEqual(bytes);
          return descriptor(second);
        },
      },
      settings,
      () => {},
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await uploads.upload("attachment", bytes, {
          expectedHash: hash,
          signal: signal(),
        }),
      ).toEqual({ url: `${second}/${hash}.bin` });
    }
    expect(requests).toEqual([
      `HEAD ${first}/upload`,
      `HEAD ${second}/upload`,
      `PUT ${second}/upload`,
      `HEAD ${second}/upload`,
      `PUT ${second}/upload`,
    ]);
    await expect(
      uploads.upload("attachment", bytes, {
        expectedHash: "ab".repeat(32),
        signal: signal(),
      }),
    ).rejects.toHaveProperty("code", "hash");
    expect(requests).toHaveLength(5);
  }
});

test("an opted-in BUD-04 failure leaves the verified primary usable", async () => {
  const { settings } = settingsFor();
  settings.save({
    mirror: true,
    servers: [first, second].map((origin) => ({
      origin,
      enabled: true,
      roles: ["attachment"],
    })),
  });
  const uploads = createMediaUploads(
    signer,
    {
      sha256,
      async request(path, opts) {
        if (path === `${second}/mirror`) {
          const mirror = JSON.parse(new TextDecoder().decode(opts.body));
          expect(mirror).toEqual({ url: `${first}/${hash}.bin` });
          return descriptor(second, { sha256: "ff".repeat(32) });
        }
        expect(path).toBe(`${first}/upload`);
        return opts.method === "HEAD"
          ? new Response(null, { status: 200 })
          : descriptor(first);
      },
    },
    settings,
    () => {},
  );
  const result = await uploads.upload("attachment", bytes, {
    expectedHash: hash,
    signal: signal(),
  });
  expect(result.url).toBe(`${first}/${hash}.bin`);
  expect(await result.mirror).toBe(false);
  expect(uploads.health(second, "attachment")?.lastFailure).toBe("descriptor");
  settings.save({ mirror: false, servers: [] });
  await expect(
    uploads.upload("attachment", bytes, {
      expectedHash: hash,
      signal: signal(),
    }),
  ).rejects.toHaveProperty("code", "configuration");
});

test("both cache policies share byte accounting and retain pinned outgoing data", () => {
  const old = { id: "old", size: 20, accessedAt: 10 };
  const pending = { id: "pending", size: 30, accessedAt: 20 };
  const newest = { id: "newest", size: 30, accessedAt: 30 };
  expect(
    cacheEvictions(
      [old, pending, newest],
      { maxBytes: 40 },
      (row) => row === pending,
    ),
  ).toEqual({ evict: [old, newest], remainingBytes: 30 });
  expect(
    cacheEvictions([old, pending, newest], { maxBytes: 90, expiresBefore: 20 }),
  ).toEqual({ evict: [old], remainingBytes: 60 });
});
