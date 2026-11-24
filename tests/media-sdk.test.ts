import { expect, test } from "bun:test";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { verifyEvent } from "nostr-tools/pure";
import { cacheEvictions } from "../src/core/media/cache-policy";
import { createBlossomClient } from "../src/core/media/blossom";
import {
  createMediaSettings,
  type MediaConfiguration,
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

test("recommended servers keep roles independent and a saved empty list stays empty", () => {
  const { settings, store } = settingsFor();
  expect(settings.configured("profile").map(({ origin }) => origin)).toEqual([
    "https://blossom.jumble.social",
  ]);
  expect(settings.configured("attachment").map(({ origin }) => origin)).toEqual(
    ["https://nostr.download"],
  );
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

test("opening media settings preserves explicitly saved storage hosts", () => {
  const saved: MediaConfiguration = {
    servers: [
      {
        origin: "https://blossom.nostr.build",
        enabled: true,
        roles: ["profile"],
      },
      {
        origin: "https://nostr.download",
        enabled: true,
        roles: ["attachment"],
      },
    ],
    mirror: false,
  };
  const key = "media.servers.v1";
  const stock = settingsFor(new Map([[key, JSON.stringify(saved)]]));
  expect(
    stock.settings.configured("profile").map(({ origin }) => origin),
  ).toEqual(["https://blossom.nostr.build"]);
  expect(createMediaSettings(stock.store).snapshot()).toEqual(
    stock.settings.snapshot(),
  );

  const customized = { ...saved, mirror: true };
  const custom = settingsFor(new Map([[key, JSON.stringify(customized)]]));
  expect(custom.settings.snapshot()).toEqual(customized);
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
      { origin: first, enabled: true, roles: ["profile"] },
      { origin: second, enabled: true, roles: ["profile", "attachment"] },
      { origin: disabled, enabled: false, roles: ["profile"] },
      { origin: foreign, enabled: true, roles: ["attachment"] },
    ],
  });
  for (const rejection of [413, 415]) {
    const requests: string[] = [];
    const uploads = createMediaUploads(
      signer,
      {
        sha256,
        async request(path, options) {
          requests.push(`${options.method ?? "GET"} ${path}`);
          if (path === `${second}/${hash}.bin`) return new Response(bytes);
          if (path.startsWith(first))
            return new Response(null, { status: rejection });
          if (options.method === "HEAD")
            return new Response(null, { status: 200 });
          expect(path).toBe(`${second}/upload`);
          expect(options.body).toEqual(bytes);
          return descriptor(second, { type: "image/jpeg" });
        },
      },
      settings,
      () => {},
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await uploads.upload("profile", bytes, {
          signal: signal(),
        }),
      ).toEqual({ url: `${second}/${hash}.bin` });
    }
    expect(requests).toEqual([
      `HEAD ${first}/upload`,
      `HEAD ${second}/upload`,
      `PUT ${second}/upload`,
      `GET ${second}/${hash}.bin`,
      `HEAD ${second}/upload`,
      `PUT ${second}/upload`,
      `GET ${second}/${hash}.bin`,
    ]);
  }
});

test("an opted-in BUD-04 failure leaves the verified primary usable", async () => {
  const { settings } = settingsFor();
  settings.save({
    mirror: true,
    servers: [first, second].map((origin) => ({
      origin,
      enabled: true,
      roles: ["profile"],
    })),
  });
  const uploads = createMediaUploads(
    signer,
    {
      sha256,
      async request(path, opts) {
        if (path === `${first}/${hash}.bin`) return new Response(bytes);
        if (path === `${second}/mirror`) {
          const mirror = JSON.parse(new TextDecoder().decode(opts.body));
          expect(mirror).toEqual({ url: `${first}/${hash}.bin` });
          return descriptor(second, { sha256: "ff".repeat(32) });
        }
        expect(path).toBe(`${first}/upload`);
        return opts.method === "HEAD"
          ? new Response(null, { status: 200 })
          : descriptor(first, { type: "image/jpeg" });
      },
    },
    settings,
    () => {},
  );
  const result = await uploads.upload("profile", bytes, {
    signal: signal(),
  });
  expect(result.url).toBe(`${first}/${hash}.bin`);
  expect(await result.mirror).toBe(false);
  expect(uploads.health(second, "profile")?.lastFailure).toBe("descriptor");
  settings.save({ mirror: false, servers: [] });
  await expect(
    uploads.upload("profile", bytes, {
      signal: signal(),
    }),
  ).rejects.toHaveProperty("code", "configuration");
});

test("private backup copies use the accepted ciphertext locator and only an enabled attachment server", async () => {
  const { settings } = settingsFor();
  const servers = [
    { origin: first, enabled: true, roles: ["attachment"] as const },
    { origin: disabled, enabled: false, roles: ["attachment"] as const },
    { origin: foreign, enabled: true, roles: ["profile"] as const },
    { origin: second, enabled: true, roles: ["attachment"] as const },
  ].map(({ roles, ...server }) => ({ ...server, roles: [...roles] }));
  settings.save({ mirror: false, servers });
  const calls: string[] = [];
  const url = `${first}/${hash}.bin`;
  const report = { url, hash, size: bytes.length };
  const sdk = createMediaUploads(
    signer,
    {
      sha256,
      async request() {
        throw new Error("Unexpected binary request");
      },
      async mirrorCommand(endpoint, headers, _signal, body) {
        calls.push(endpoint);
        expect(JSON.parse(body)).toEqual({ url });
        expect(headers["X-SHA-256"]).toBe(hash);
        return { status: 201, body: await descriptor(second).text() };
      },
    },
    settings,
    () => {},
  );
  expect(await sdk.mirrorAttachments([report], signal(), () => true)).toBe(
    true,
  );
  expect(calls).toEqual([]);
  settings.save({ mirror: true, servers });
  expect(await sdk.mirrorAttachments([report], signal(), () => true)).toBe(
    true,
  );
  expect(calls).toEqual([`${second}/mirror`]);
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
