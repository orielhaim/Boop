import { expect, test } from "bun:test";
import {
  blossomCandidates,
  blossomDownload,
  checkedBlossomUrls,
  firstBlossomDownload,
  tryBlossomOrigins,
} from "../src/core/downloads/blossom";

const hash = "a".repeat(64);
const otherHash = "b".repeat(64);

test("parses a public HTTPS blob URL and derives its filename and MIME type", () => {
  const source = blossomDownload(
    `https://cdn.example.com/${hash.toUpperCase()}.JPG`,
  );

  expect(source).toEqual({
    kind: "http",
    artifact: "blossom",
    hash,
    total: null,
    expectedSize: null,
    name: `${hash}.jpg`,
    type: "image/jpeg",
    urls: [`https://cdn.example.com/${hash.toUpperCase()}.JPG`],
    authors: [],
    expiresAt: null,
  });
});

test("parses Blossom hints, sanitizes metadata, and rejects conflicting sizes", () => {
  const uri =
    `blossom:${hash}.MP4?xs=cdn.example.com&xs=https%3A%2F%2Fcdn.example.com&` +
    `as=${otherHash}&as=${otherHash}&sz=23`;
  const source = blossomDownload(uri, {
    author: hash,
    hash: hash.toUpperCase(),
    total: 23,
    name: " /family/clip?.mp4 ",
    type: "not a mime type",
  });

  expect(source).toEqual({
    kind: "http",
    artifact: "blossom",
    hash,
    total: 23,
    expectedSize: 23,
    name: "_family_clip?.mp4",
    type: "video/mp4",
    urls: [`https://cdn.example.com/${hash}`],
    authors: [hash, otherHash],
    expiresAt: null,
  });
  expect(blossomDownload(uri, { total: 24 })).toBeUndefined();
});

test("rejects unsafe blob addresses and malformed references", () => {
  expect(blossomDownload(`http://cdn.example.com/${hash}.jpg`)).toBeUndefined();
  expect(blossomDownload(`https://localhost/${hash}.jpg`)).toBeUndefined();
  expect(
    blossomDownload(`https://cdn.example.com/${hash}.jpg?token=secret`),
  ).toBeUndefined();
  expect(
    blossomDownload(`blossom:${hash}.bad-extension-is-long`),
  ).toBeUndefined();
  expect(
    blossomDownload(`https://cdn.example.com/${hash}.jpg`, { hash: otherHash }),
  ).toBeUndefined();
});

test("normalizes, deduplicates, and caps server candidates", () => {
  const origins = Array.from(
    { length: 10 },
    (_, index) => `cdn-${index}.example.com`,
  );
  const candidates = blossomCandidates(hash, [
    "cdn-0.example.com",
    "https://cdn-0.example.com/",
    "http://cdn-unsafe.example.com",
    "https://cdn-path.example.com/files",
    ...origins,
  ]);

  expect(candidates).toEqual(
    origins.slice(0, 8).map((origin) => `https://${origin}/${hash}`),
  );
});

test("extracts a valid link and checks that candidate URLs match its hash", () => {
  const source = firstBlossomDownload(
    `See (https://cdn.example.com/${hash}.png,) and then https://cdn.example.com/${otherHash}.png`,
    otherHash,
  );

  expect(source?.hash).toBe(hash);
  if (!source) throw new Error("Expected a valid Blossom link");
  expect(
    checkedBlossomUrls({
      ...source,
      urls: [
        `https://cdn.example.com/${hash}.png`,
        `https://cdn.example.com/${otherHash}.png`,
      ],
    }),
  ).toEqual([`https://cdn.example.com/${hash}.png`]);
});

test("tries initial and discovered origins in order using a controlled local server", async () => {
  const requests: string[] = [];
  const statuses = new Map([
    ["/first", 404],
    ["/second", 422],
    ["/ready", 200],
  ]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      return new Response(null, { status: statuses.get(path) ?? 404 });
    },
  });

  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const state = await tryBlossomOrigins(
      [`${origin}/first`, `${origin}/second`],
      async () => [`${origin}/first`, `${origin}/ready`],
      async (url) => {
        const response = await fetch(url);
        if (response.status === 200) return "ready";
        if (response.status === 422) return "integrity";
        if (response.status === 507) return "storage_blocked";
        return "unavailable";
      },
      new AbortController().signal,
    );

    expect(state).toBe("ready");
    expect(requests).toEqual(["/first", "/second", "/ready"]);
  } finally {
    server.stop(true);
  }
});

test("returns storage exhaustion immediately and preserves an integrity failure", async () => {
  const storage = await tryBlossomOrigins(
    ["https://one.example.com/blob"],
    async () => ["https://two.example.com/blob"],
    async (url) =>
      url.includes("one.example.com") ? "storage_blocked" : "ready",
    new AbortController().signal,
  );
  expect(storage).toBe("storage_blocked");

  const failed = await tryBlossomOrigins(
    ["https://one.example.com/blob", "https://two.example.com/blob"],
    async () => ["https://three.example.com/blob"],
    async (url) =>
      url.includes("one.example.com") ? "integrity" : "unavailable",
    new AbortController().signal,
  );
  expect(failed).toBe("integrity");
});

test("bounds unique origin attempts and stops when the signal is aborted", async () => {
  const manyUrls = Array.from(
    { length: 20 },
    (_, index) => `https://server-${index}.example.com/${hash}`,
  );
  const attempted: string[] = [];
  const bounded = await tryBlossomOrigins(
    manyUrls,
    async () => manyUrls,
    async (url) => {
      attempted.push(url);
      return "unavailable";
    },
    new AbortController().signal,
  );

  expect(bounded).toBe("unavailable");
  expect(attempted).toEqual(manyUrls.slice(0, 12));

  const controller = new AbortController();
  const cancelledAttempts: string[] = [];
  const interrupted = await tryBlossomOrigins(
    manyUrls.slice(0, 2),
    async () => ["https://discovered.example.com/blob"],
    async (url) => {
      cancelledAttempts.push(url);
      controller.abort();
      return "interrupted";
    },
    controller.signal,
  );

  expect(interrupted).toBe("interrupted");
  expect(cancelledAttempts).toEqual([manyUrls[0]]);
});
