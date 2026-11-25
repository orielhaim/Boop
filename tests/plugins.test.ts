import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { randomBytes } from "node:crypto";
import {
  createPluginHost,
  type Embed,
  type Plugin,
} from "../src/core/plugins/host";
import { torrents } from "../src/plugins/torrents/descriptor";
import { parseMagnet } from "../src/plugins/torrents/magnets";
import { pluginMessageText } from "../src/core/plugins/message-content";
import { torrentMetadataCache } from "../src/db/torrents";
import * as schema from "../src/db/schema";
import { initializeTestDatabase } from "./db-fixture";
import { createTorrents } from "../src/plugins/torrents/service";
import type { TorrentDelivery } from "../src/core/plugins/delivery";
import type { TorrentMetadata } from "../src/plugins/torrents/contracts";

const hash = "0123456789abcdef0123456789abcdef01234567";
const magnet = `magnet:?xt=urn:btih:${hash}`;

describe("official plugin host", () => {
  test("skips unauthorized, unrelated, and oversized content", () => {
    let calls = 0;
    const extension: Plugin<Embed> = {
      ...torrents,
      content: {
        prefix: "magnet:?",
        match() {
          calls++;
          return [];
        },
      },
    };
    const host = createPluginHost([extension]);
    expect(host.match({ text: magnet, eligible: false })).toEqual([]);
    expect(host.match({ text: "ordinary message", eligible: true })).toEqual(
      [],
    );
    expect(host.match({ text: magnet.repeat(500), eligible: true })).toEqual(
      [],
    );
    expect(calls).toBe(0);
    host.match({ text: magnet, eligible: true });
    expect(calls).toBe(1);
  });

  test("aborts pending activation and drains the returned cleanup exactly once", async () => {
    const started = Promise.withResolvers();
    const settle = Promise.withResolvers();
    const events: string[] = [];
    const host = createPluginHost([
      {
        ...torrents,
        async activate(signal) {
          signal.addEventListener("abort", () => events.push("abort"));
          started.resolve();
          await settle.promise;
          return async () => {
            events.push("close");
          };
        },
      },
    ]);
    const opening = host.activate("torrents");
    await started.promise;
    const closing = host.dispose();
    settle.resolve();
    await Promise.all([opening, closing, host.dispose()]);
    expect(events).toEqual(["abort", "close"]);
  });

  test("finds independent magnet destinations and excludes code and quotes", () => {
    const host = createPluginHost([torrents]);
    const second = "b".repeat(40);
    const quoted = `magnet:?xt=urn:btih:${"c".repeat(40)}`;
    const text = [
      `[video](${magnet})`,
      `> ${quoted}`,
      "```",
      quoted,
      "```",
      `\`${quoted}\` <magnet:?xt=urn:btih:${second}> ${magnet}.`,
    ].join("\n");
    expect(host.match({ text, eligible: true }).map(({ id }) => id)).toEqual([
      `torrents:${hash}`,
      `torrents:${second}`,
    ]);
  });
});

test("canonicalizes hex and Base32 v1 identities, strips unsupported URI fields", () => {
  const zeros = "0".repeat(40);
  expect(
    parseMagnet(
      `magnet:?xt=urn%3Abtih%3A${"a".repeat(32)}&xs=http%3A%2F%2Fexample.com%2Ftorrent`,
    ),
  ).toEqual({
    infoHash: zeros,
    uri: `magnet:?xt=urn:btih:${zeros}`,
  });
  expect(parseMagnet(`${magnet}&xt=urn:btih:${zeros}`)).toBeUndefined();
  expect(
    parseMagnet(`magnet:?xt=urn:btmh:1220${"b".repeat(64)}`),
  ).toBeUndefined();
});

test("filters SDK quote and code nodes before plugin matching", () => {
  const host = createPluginHost([torrents]);
  const kept = "d".repeat(40);
  const text = pluginMessageText(magnet, {
    truncated: false,
    blocks: [
      { kind: "code", text: magnet },
      { kind: "quote", children: [{ kind: "text", text: magnet }] },
      {
        kind: "paragraph",
        children: [
          {
            kind: "link",
            pluginDestination: `magnet:?xt=urn:btih:${kept}`,
            children: [{ kind: "text", text: magnet }],
          },
        ],
      },
    ],
  });
  expect(host.match({ text, eligible: true }).map(({ id }) => id)).toEqual([
    `torrents:${kept}`,
  ]);
});

test("cache retains pinned metadata and encrypts identity, metadata, and filenames", () => {
  using sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  const key = randomBytes(32);
  const cache = torrentMetadataCache(db, key, randomBytes);
  const metadata = {
    torrentId: hash,
    name: "Private torrent label",
    files: [{ index: 0, path: ["fixture.mp4"], size: 2 ** 33 }],
    metadata: "YWJjZA==",
  };
  cache.put(metadata, []);
  const persisted = JSON.stringify(db.select().from(schema.torrentCache).all());
  expect(persisted).not.toContain(hash);
  expect(persisted).not.toContain("fixture.mp4");
  expect(
    torrentMetadataCache(db, randomBytes(32), randomBytes).get(hash),
  ).toBeUndefined();
  const restarted = torrentMetadataCache(db, key, randomBytes);
  expect(restarted.get(hash)).toEqual(metadata);
  restarted.clear([hash]);
  expect(restarted.get(hash)).toEqual(metadata);
  restarted.clear([]);
  expect(restarted.get(hash)).toBeUndefined();
});

function pluginFixture(execute: TorrentDelivery["execute"]) {
  const cache = new Map<string, TorrentMetadata>();
  const loaded: number[] = [];
  const plugin = createTorrents({
    delivery: {
      status: async () => ({ kind: "installed" }),
      install: async () => ({ kind: "installed" }),
      cancel: async () => undefined,
      confirm: async () => false,
      uninstall: async () => undefined,
      subscribe: () => () => undefined,
      load: async () => {
        loaded.push(1);
        return 1;
      },
      execute,
    },
    newId: () => "request-id",
    scope: "fixture-scope",
    cache: {
      get: (id) => cache.get(id),
      put: (metadata) => {
        cache.set(metadata.torrentId, metadata);
      },
      clear: () => cache.clear(),
      bytes: () => cache.size,
    },
    canAccess: () => true,
    readPreference: () => null,
    writePreference: () => undefined,
    pinned: () => [],
    pauseDownloads: async () => undefined,
    onEligibilityChange: () => undefined,
  });
  return { plugin, loaded };
}

test("enabling Torrents starts no native work and equal magnets share a resolution", async () => {
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<string>();
  const calls: string[] = [];
  const { plugin, loaded } = pluginFixture(async (_, request) => {
    const { kind } = JSON.parse(request);
    calls.push(kind);
    if (kind === "resolve") {
      entered.resolve();
      return response.promise;
    }
    return '{"kind":"stopped"}';
  });
  await plugin.refresh();
  await plugin.enable(true);
  expect(plugin.state.getState().policy).toBe("onTap");
  expect(loaded).toEqual([]);
  expect(calls).toEqual([]);
  const vanished = new AbortController();
  const first = plugin.resolve(
    { infoHash: hash, uri: magnet },
    vanished.signal,
  );
  const second = plugin.resolve(
    { infoHash: hash, uri: magnet },
    new AbortController().signal,
  );
  await entered.promise;
  vanished.abort();
  await expect(first).rejects.toThrow("Cancelled");
  const result = {
    torrentId: hash,
    name: "Sample",
    files: [{ index: 0, path: ["sample.mp4"], size: 43 }],
  };
  response.resolve(
    JSON.stringify({ kind: "resolved", ...result, metadata: "YQ==" }),
  );
  expect(await second).toEqual(result);
  expect(
    await plugin.resolve(
      { infoHash: hash, uri: magnet },
      new AbortController().signal,
    ),
  ).toEqual(result);
  expect(loaded).toEqual([1]);
  expect(calls).toEqual(["resolve", "cancel"]);
  await plugin.enable(false);
  expect(calls).toEqual(["resolve", "cancel", "shutdown"]);
  await expect(
    plugin.resolve(
      { infoHash: hash, uri: magnet },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Unavailable");
  await plugin.dispose();
});
