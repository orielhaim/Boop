import type { TransferProgress } from "../src/core/downloads/transport";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDownloadManager } from "../src/core/downloads/manager";
import {
  downloadId,
  sourceId,
  type BlossomDownload,
  type MarmotDownload,
  type ProviderDownload,
  type TorrentsDownload,
} from "../src/core/downloads/types";
import { downloadTransports } from "../src/core/downloads/transport";
import { createAttachmentPresentation } from "../src/core/marmot/attachment-presentation";
import { downloadStore } from "../src/db/downloads";
import * as schema from "../src/db/schema";
import { initializeTestDatabase } from "./db-fixture";

const source = (id: string, hash?: string): MarmotDownload => ({
  kind: "marmot",
  target: ["group", id, "verified-source", 0],
  name: "private attachment " + id,
  type: "image/jpeg",
  sender: "peer",
  total: 400,
  expiresAt: null,
  hash,
});
const id = (name: string) => downloadId(source(name).target);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("provider downloads use a stable provider scoped identity", () => {
  const torrent: TorrentsDownload = {
    kind: "provider",
    provider: "torrents",
    version: 1,
    payload: { torrentId: "a".repeat(40), fileIndex: 3 },
    name: "episode.mkv",
    type: "video/x-matroska",
    total: null,
    expiresAt: null,
  };
  expect(sourceId(torrent)).toBe(`provider:torrents:1:${"a".repeat(40)}:3`);
  expect(sourceId(torrent)).toBe(sourceId({ ...torrent, name: "renamed.mkv" }));
});

test("attaches progressive readers to a single durable transfer and keeps it after closing playback", async () => {
  using sqlite = new Database(":memory:");
  const { store } = fixture(sqlite);
  const source: TorrentsDownload = {
    kind: "provider",
    provider: "torrents",
    version: 1,
    payload: { torrentId: "c".repeat(40), fileIndex: 1 },
    name: "clip.mp4",
    type: "video/mp4",
    total: 300,
    expiresAt: null,
  };
  const id = sourceId(source);
  const complete = Promise.withResolvers<string>();
  let foreground = true;
  let starts = 0;
  let leases = 0;
  let transferSignal: AbortSignal | undefined;
  const manager = createDownloadManager({
    store,
    eligible: () => foreground,
    continueInBackground: () => true,
    authorized: () => true,
    transport: {
      available: () => true,
      canStream: () => true,
      transfer: async (_, progress, signal) => {
        starts++;
        transferSignal = signal;
        progress({ state: "downloading", received: 120, total: 300 });
        return complete.promise;
      },
      async openProgressive() {
        const uri = `boop-media://fixture-${++leases}`;
        return {
          uri,
          size: 300,
          release: async () => {
            leases--;
          },
        };
      },
      status: async () => "unavailable",
      control: async () => {},
    },
  });
  const stop = manager.start();
  try {
    manager.enqueue(source);
    manager.enqueue({ ...source, name: "same-source.mp4" });
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      manager.openProgressive(source, signal),
      manager.openProgressive(source, signal),
    ]);
    expect(first.kind).toBe("progressive");
    expect(second.kind).toBe("progressive");
    expect(starts).toBe(1);
    expect(store.load()).toHaveLength(1);
    expect(manager.get(id)?.received).toBe(120);
    if (first.kind === "progressive") await first.read.release();
    if (second.kind === "progressive") await second.read.release();
    expect(leases).toBe(0);
    foreground = false;
    manager.sync();
    expect(transferSignal?.aborted).toBe(false);
    complete.resolve("ready");
    await tick();
    expect(manager.get(id)?.state).toBe("completed");
    expect(starts).toBe(1);
  } finally {
    complete.resolve("interrupted");
    stop();
    await manager.drain();
  }
});

test("restores a previously active torrent as paused after an unclean process exit", async () => {
  using sqlite = new Database(":memory:");
  const { store } = fixture(sqlite);
  const source: TorrentsDownload = {
    kind: "provider",
    provider: "torrents",
    version: 1,
    payload: { torrentId: "d".repeat(40), fileIndex: 1 },
    name: "clip.mp4",
    type: "video/mp4",
    total: 300,
    expiresAt: null,
  };
  const id = sourceId(source);
  store.save([
    {
      ...source,
      id,
      state: "active",
      received: 120,
      createdAt: 0,
      changedAt: 0,
      order: 1,
      retries: 0,
      retryAt: 0,
    },
  ]);
  let starts = 0;
  const manager = createDownloadManager({
    store,
    eligible: () => true,
    authorized: () => true,
    transport: {
      available: () => true,
      transfer: async () => {
        starts++;
        return "system_stopped";
      },
      status: async () => "unavailable",
      control: async () => {},
    },
  });
  const stop = manager.start();
  try {
    await manager.reconcile();
    expect(manager.get(id)?.state).toBe("paused");
    expect(starts).toBe(0);
    manager.resume(id);
    await tick();
    expect(starts).toBe(1);
    expect(manager.get(id)?.state).toBe("paused");
  } finally {
    stop();
    await manager.drain();
  }
});

test("promotes a queued video ahead of its active sibling without cancelling the sibling job", async () => {
  using sqlite = new Database(":memory:");
  const { store } = fixture(sqlite);
  const earlier: TorrentsDownload = {
    kind: "provider",
    provider: "torrents",
    version: 1,
    payload: { torrentId: "e".repeat(40), fileIndex: 0 },
    name: "earlier.mp4",
    type: "video/mp4",
    total: 300,
    expiresAt: null,
  };
  const selected = {
    ...earlier,
    payload: { ...earlier.payload, fileIndex: 1 },
    name: "selected.mp4",
  };
  const firstStarted = Promise.withResolvers<void>();
  const interrupted: string[] = [];
  const starts: string[] = [];
  const manager = createDownloadManager({
    store,
    eligible: () => true,
    authorized: () => true,
    transport: {
      available: () => true,
      canStream: () => true,
      async transfer(source, _, signal) {
        starts.push(source.name);
        firstStarted.resolve();
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              interrupted.push(source.name);
              resolve("interrupted");
            },
            { once: true },
          );
        });
      },
      async openProgressive() {
        return {
          uri: "boop-media://selected",
          size: 300,
          release: async () => {},
        };
      },
      status: async () => "unavailable",
      control: async () => {},
    },
  });
  const stop = manager.start();
  try {
    manager.enqueue(earlier);
    manager.enqueue(selected);
    await firstStarted.promise;
    const lease = await manager.openProgressive(
      selected,
      new AbortController().signal,
    );
    expect(lease.kind).toBe("progressive");
    if (lease.kind === "progressive") await lease.read.release();
    expect(starts).toEqual(["earlier.mp4", "selected.mp4"]);
    expect(interrupted).toEqual(["earlier.mp4"]);
    expect(manager.get(sourceId(earlier))?.state).toBe("queued");
    expect(
      store
        .load()
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["earlier.mp4", "selected.mp4"]);
  } finally {
    stop();
    await manager.drain();
  }
});

test("unknown provider versions remain unavailable and removable", async () => {
  using sqlite = new Database(":memory:");
  const { store } = fixture(sqlite);
  const unknown = {
    kind: "provider" as const,
    provider: "future-source",
    version: 8,
    payload: { opaque: true },
    name: "future.bin",
    type: "application/octet-stream",
    total: null,
    expiresAt: null,
  };
  const jobId = sourceId(unknown);
  store.save([
    {
      ...unknown,
      id: jobId,
      state: "queued",
      received: 0,
      createdAt: 1,
      changedAt: 1,
      order: 1,
      retries: 0,
      retryAt: 0,
    },
  ]);
  const restored = store.load();
  expect(restored).toHaveLength(1);
  expect(restored[0]).toMatchObject({ provider: "future-source", version: 8 });
  const manager = createDownloadManager({
    store,
    eligible: () => true,
    authorized: () => true,
    transport: {
      transfer: async () => "ready",
      status: async () => undefined,
      control: async () => {},
    },
  });
  expect(manager.get(jobId)).toMatchObject({
    state: "failed",
    issue: "unavailable",
  });
  const stop = manager.start();
  await manager.remove(jobId);
  expect(manager.get(jobId)).toBeUndefined();
  stop();
});

test("provider transport dispatch is gated by the declared version", async () => {
  const calls: string[] = [];
  const torrent: TorrentsDownload = {
    kind: "provider",
    provider: "torrents",
    version: 1,
    payload: { torrentId: "b".repeat(40), fileIndex: 0 },
    name: "file",
    type: "application/octet-stream",
    total: null,
    expiresAt: null,
  };
  const transports = downloadTransports(
    {
      transfer: async () => "ready",
      status: async () => undefined,
      control: async () => {},
    },
    {
      transfer: async () => "ready",
      status: async () => undefined,
      control: async () => {},
    },
    {
      torrents: {
        supportedVersions: [1],
        async transfer() {
          calls.push("transfer");
          return "ready";
        },
        async status() {
          return undefined;
        },
        async control() {},
      },
    },
  );
  expect(transports.available?.(torrent)).toBe(true);
  expect(
    await transports.transfer(torrent, () => {}, new AbortController().signal),
  ).toBe("ready");
  expect(calls).toEqual(["transfer"]);
  const future: ProviderDownload = { ...torrent, version: 2 };
  expect(transports.available?.(future)).toBe(false);
  expect(
    await transports.transfer(future, () => {}, new AbortController().signal),
  ).toBe("unavailable");
});

test("suspends a disabled provider and serializes selected files from one torrent", async () => {
  using sqlite = new Database(":memory:");
  const { store } = fixture(sqlite);
  let enabled = true;
  const first: TorrentsDownload = {
    kind: "provider",
    provider: "torrents",
    version: 1,
    payload: { torrentId: "e".repeat(40), fileIndex: 0 },
    name: "first.mp4",
    type: "video/mp4",
    total: 500,
    expiresAt: null,
  };
  const sibling: TorrentsDownload = {
    ...first,
    name: "second.mp4",
    payload: { ...first.payload, fileIndex: 1 },
  };
  const admitted: string[] = [];
  const manager = createDownloadManager({
    store,
    eligible: () => true,
    authorized: () => true,
    transferAvailable: (source) => source.kind !== "provider" || enabled,
    transport: {
      available: () => true,
      transfer: async (source, _, signal) => {
        admitted.push(sourceId(source));
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return "interrupted";
      },
      status: async () => "unavailable",
      control: async () => undefined,
    },
  });
  manager.start();
  try {
    manager.enqueue(first);
    manager.enqueue(sibling);
    await tick();
    expect(admitted).toEqual([sourceId(first)]);
    enabled = false;
    manager.sync();
    await tick();
    expect(store.load().map(({ state }) => state)).toEqual([
      "queued",
      "queued",
    ]);
    expect(admitted).toEqual([sourceId(first)]);
    enabled = true;
    manager.sync();
    await tick();
    expect(admitted).toEqual([sourceId(first), sourceId(first)]);
  } finally {
    await manager.drain();
  }
});

test("a retained attachment lease cannot escape when account policy becomes unavailable", async () => {
  using sqlite = new Database(":memory:");
  const { store } = fixture(sqlite);
  let available = true;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const manager = createDownloadManager({
    store,
    eligible: () => true,
    available: () => available,
    authorized: () => true,
    transport: {
      transfer: async () => "ready",
      status: async () => "ready",
      control: async () => {},
      async open(_job, consume) {
        entered.resolve();
        await release.promise;
        await consume({
          path: "/verified-local",
          name: "file",
          type: "image/jpeg",
        });
      },
    },
  });
  const stop = manager.start();
  try {
    manager.enqueue(source("lease"));
    await tick();
    expect(manager.get(id("lease"))?.state).toBe("completed");
    let opened = false;
    const attempt = manager.open(id("lease"), async () => {
      opened = true;
    });
    await entered.promise;
    available = false;
    release.resolve();
    await attempt;
    expect(opened).toBe(false);
    expect(manager.get(id("lease"))?.state).toBe("completed");
  } finally {
    release.resolve();
    stop();
  }
});

test("removing a completed download waits for its playback lease to retire", async () => {
  using sqlite = new Database(":memory:");
  const { store } = fixture(sqlite);
  const release = Promise.withResolvers<void>();
  const retired = Promise.withResolvers<void>();
  let removed = false;
  const retained = source("playing");
  const manager = createDownloadManager({
    store,
    eligible: () => true,
    authorized: () => true,
    transport: {
      transfer: async () => "ready",
      status: async () => "ready",
      async control(_source, action) {
        if (action === "remove") removed = true;
      },
    },
  });
  const stop = manager.start();
  try {
    manager.enqueue(retained);
    await tick();
    expect(manager.get(id("playing"))?.state).toBe("completed");
    const unpin = manager.holdForPlayback(retained, async () => {
      retired.resolve();
      await release.promise;
      unpin?.();
    });
    expect(unpin).toBeDefined();
    const removing = manager.remove(id("playing"));
    await retired.promise;
    expect(removed).toBe(false);
    expect(manager.holdForPlayback(retained, async () => {})).toBeUndefined();
    release.resolve();
    await removing;
    expect(removed).toBe(true);
    expect(manager.get(id("playing"))).toBeUndefined();
  } finally {
    release.resolve();
    stop();
  }
});

function fixture(sqlite: Database) {
  initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  const nonce = (size: number) => crypto.getRandomValues(new Uint8Array(size));
  const key = new Uint8Array(32).fill(7);
  const store = downloadStore(db, "account", key, nonce);
  const calls: string[] = [];
  const statuses = new Map<string, string>();
  const held = new Map<
    string,
    {
      progress: (event: TransferProgress) => void;
      resolve: (state: string) => void;
    }
  >();
  let time = 1_000;
  let eligible = true;
  let authorized = true;
  const completed: string[] = [];
  const create = (concurrency = 2) =>
    createDownloadManager({
      store,
      concurrency,
      now: () => time,
      random: () => 0.5,
      eligible: () => eligible,
      authorized: () => authorized,
      completed: (item) => {
        if (item.kind === "marmot") completed.push(item.target[1]);
      },
      transport: {
        async status(item) {
          if (item.kind !== "marmot") throw new Error("Unexpected transport");
          return statuses.get(item.target[1]) ?? "not_requested";
        },
        async control(item, action) {
          if (item.kind !== "marmot") throw new Error("Unexpected transport");
          const name = item.target[1];
          if (statuses.get(name) === "ready" && action !== "remove") return;
          statuses.set(name, action === "remove" ? "removed" : "cancelled");
        },
        async transfer(item, progress, signal) {
          if (item.kind !== "marmot") throw new Error("Unexpected transport");
          const name = item.target[1];
          calls.push(name);
          statuses.set(name, "downloading");
          const result = Promise.withResolvers<string>();
          held.set(name, { progress, resolve: result.resolve });
          signal.addEventListener("abort", () => result.resolve("cancelled"), {
            once: true,
          });
          const phase = await result.promise;
          held.delete(name);
          statuses.set(name, phase);
          return phase;
        },
      },
    });
  function finish(id: string, phase = "ready") {
    const task = held.get(id);
    if (!task) throw new Error(`No active transfer for ${id}`);
    task.resolve(phase);
  }
  return {
    store,
    db,
    key,
    nonce,
    calls,
    statuses,
    held,
    create,
    finish,
    completed,
    time: (value: number) => {
      time = value;
    },
    eligible: (value: boolean) => {
      eligible = value;
    },
    authorized: (value: boolean) => {
      authorized = value;
    },
  };
}

test("queue deduplicates, respects concurrency, and persists manual order before scheduling", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create();
  const stop = manager.start();
  manager.enqueue(source("one"));
  manager.enqueue(source("one"));
  manager.enqueue(source("two"));
  manager.enqueue(source("three"));
  manager.enqueue(source("four"));
  await tick();
  expect(f.calls).toEqual(["one", "two"]);
  manager.reorder(id("four"), id("three"));
  expect(f.store.load().find((job) => job.id === id("four"))?.order).toBe(3);
  f.finish("two");
  await tick();
  expect(f.calls).toEqual(["one", "two", "four"]);
  f.finish("four");
  f.finish("one");
  await tick();
  f.finish("three");
  await tick();
  expect(f.calls).toEqual(["one", "two", "four", "three"]);
  expect(manager.snapshot().map((job) => job.state)).toEqual(
    Array(4).fill("completed"),
  );
  stop();
});

test("shared content waits for native verified reuse, while unrelated work can start", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create();
  const stop = manager.start();
  manager.enqueue(source("one", "same-hash"));
  manager.enqueue(source("two", "same-hash"));
  manager.enqueue(source("three", "another-hash"));
  await tick();
  expect(f.calls).toEqual(["one", "three"]);
  f.finish("one");
  await tick();
  expect(f.calls).toEqual(["one", "three", "two"]);
  f.finish("two");
  f.finish("three");
  await tick();
  stop();
});

test("moving to cellular checkpoints excess transfers and resumes them in order", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create();
  const stop = manager.start();
  for (const name of ["one", "two", "three"]) manager.enqueue(source(name));
  await tick();
  expect(f.calls).toEqual(["one", "two"]);
  manager.network(true, true);
  await tick();
  expect([...f.held.keys()]).toEqual(["one"]);
  expect(manager.get(id("two"))?.state).toBe("queued");
  f.finish("one");
  await tick();
  expect(f.calls).toEqual(["one", "two", "two"]);
  expect([...f.held.keys()]).toEqual(["two"]);
  stop();
});

test("encrypted rows recover after restart and remain scoped to the current identity", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const first = f.create(1);
  const stop = first.start();
  first.enqueue(source("one"));
  await tick();
  f.finish("one");
  await tick();
  first.enqueue(source("two"));
  first.enqueue(source("three"));
  await tick();
  await first.pause(id("three"));
  stop();
  await first.beforeAccountClose();

  expect(
    f.db
      .select()
      .from(schema.downloads)
      .all()
      .every(
        (row) =>
          !row.job.includes("private attachment") &&
          !row.id.includes("verified-source"),
      ),
  ).toBe(true);
  expect(downloadStore(f.db, "another", f.key, f.nonce).load()).toEqual([]);
  expect(
    downloadStore(f.db, "account", new Uint8Array(32), f.nonce).load(),
  ).toEqual([]);

  const reopened = f.create(1);
  const stopReopened = reopened.start();
  await tick();
  expect(f.calls).toEqual(["one", "two", "two"]);
  expect(reopened.get(id("one"))?.state).toBe("completed");
  expect(reopened.get(id("three"))?.state).toBe("paused");
  f.finish("two");
  await tick();
  stopReopened();
});

test("an interrupted job backs off while another finishes and offline admission stops", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create(1);
  const stop = manager.start();
  manager.network(false, true);
  manager.enqueue(source("one"));
  manager.enqueue(source("two"));
  await tick();
  expect(f.calls).toEqual([]);
  manager.network(true, true);
  await tick();
  f.finish("one", "interrupted");
  await tick();
  expect(manager.get(id("one"))).toMatchObject({
    state: "waiting",
    retryAt: 3_000,
  });
  expect(f.calls).toEqual(["one", "two"]);
  f.finish("two", "storage_blocked");
  await tick();
  expect(manager.get(id("two"))).toMatchObject({
    state: "failed",
    issue: "storage",
  });
  f.time(3_000);
  manager.sync();
  await tick();
  expect(f.calls).toEqual(["one", "two", "one"]);
  f.finish("one", "unavailable");
  await tick();
  expect(manager.get(id("one"))).toMatchObject({
    state: "failed",
    issue: "unavailable",
  });
  stop();
});

test("paused jobs stay out of the header and a cancel race preserves the verified copy", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create(1);
  const stop = manager.start();
  manager.enqueue(source("one"));
  manager.enqueue(source("two"));
  await tick();
  await manager.pause(id("two"));
  expect(manager.get(id("two"))?.state).toBe("paused");
  expect(manager.indicator().count).toBe(2);
  expect(f.held.size).toBe(1);
  await manager.pause(id("one"));
  expect(manager.get(id("one"))?.state).toBe("paused");
  expect(manager.indicator()).toEqual({ selected: undefined, count: 0 });
  manager.resume(id("one"));
  await tick();
  f.finish("one");
  await manager.cancel(id("one"));
  expect(manager.get(id("one"))?.state).toBe("completed");
  expect(manager.indicator()).toEqual({ selected: undefined, count: 0 });
  await manager.remove(id("one"));
  await manager.remove(id("two"));
  expect(f.store.load()).toEqual([]);
  expect(f.statuses.get("one")).toBe("removed");
  stop();
});

test("an invalidated active source cannot publish a completed row or prevent the next job", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create(1);
  const stop = manager.start();
  manager.enqueue(source("one"));
  manager.enqueue(source("two"));
  await tick();
  f.authorized(false);
  await manager.reconcile();
  expect(f.store.load()).toEqual([]);
  expect(f.completed).toEqual([]);
  expect(f.held.size).toBe(0);
  stop();
});

test("chat mounting requests no bytes, leaving chat keeps the transfer, and reopening opens a verified lease", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create();
  const stop = manager.start();
  const target = source("one").target;
  const local = {
    path: "/verified/image.jpg",
    lease: "lease",
    name: "image.jpg",
    type: "image/jpeg",
  };
  const released: string[] = [];
  const presentation = createAttachmentPresentation(
    {
      retainedAttachmentBytes: async () =>
        f.statuses.get("one") === "ready" ? 400 : null,
      openAttachment: async () =>
        f.statuses.get("one") === "ready" ? local : null,
      releaseAttachment: async (lease) => {
        released.push(lease);
      },
    },
    manager,
    () => source("one"),
    () => true,
  );
  const availability: boolean[] = [];
  const offAvailability = presentation.subscribeAvailability(() => {
    availability.push(presentation.hasLocalFile(target));
  });
  const off = presentation.subscribe(target, () => {});
  await tick();
  expect(presentation.state(id("one"))).toEqual({ kind: "remote" });
  expect(f.calls).toEqual([]);
  presentation.download(id("one"), false);
  presentation.download(id("one"), false);
  await tick();
  expect(f.calls).toEqual(["one"]);
  off();
  f.finish("one");
  await tick();
  expect(f.completed).toEqual(["one"]);
  const reopened = presentation.subscribe(target, () => {});
  await tick();
  expect(presentation.state(id("one"))).toEqual({ kind: "cached" });
  presentation.prepare(id("one"));
  await tick();
  expect(presentation.state(id("one"))).toEqual({
    kind: "local",
    lease: local,
  });
  reopened();
  expect(released).toEqual(["lease"]);
  expect(availability).toEqual([true, false]);
  offAvailability();
  stop();
});

test("an observed download completion is immediately available while retained checks are pending", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create();
  const stop = manager.start();
  const { target } = source("one");
  const lookup = Promise.withResolvers<number | null>();
  const presentation = createAttachmentPresentation(
    {
      retainedAttachmentBytes: () => lookup.promise,
      openAttachment: async () => null,
      releaseAttachment: async () => {},
    },
    manager,
    () => source("one"),
    () => true,
  );
  const unsubscribe = presentation.subscribe(target, () => {});
  try {
    presentation.download(id("one"), false);
    await tick();
    expect(presentation.state(id("one"))).toMatchObject({
      kind: "downloading",
    });
    f.finish("one");
    await tick();
    expect(manager.get(id("one"))?.state).toBe("completed");
    expect(presentation.state(id("one"))).toEqual({ kind: "cached" });
  } finally {
    unsubscribe();
    lookup.resolve(null);
    stop();
  }
});

test("a previously downloaded attachment needs Download again if no local bytes remain", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create();
  const stop = manager.start();
  const target = source("one").target;
  const lookup = Promise.withResolvers<number | null>();
  let nextLookup = lookup.promise;
  const presentation = createAttachmentPresentation(
    {
      retainedAttachmentBytes: () => nextLookup,
      openAttachment: async () => null,
      releaseAttachment: async () => {},
    },
    manager,
    () => source("one"),
    () => true,
  );

  manager.enqueue(source("one"));
  await tick();
  f.finish("one");
  await tick();
  expect(manager.get(id("one"))?.state).toBe("completed");

  f.statuses.set("one", "previously_acquired_unavailable");
  const unsubscribe = presentation.subscribe(target, () => {});
  expect(presentation.hasLocalFile(target)).toBe(false);
  lookup.resolve(null);
  await tick();
  expect(presentation.state(id("one"))).toEqual({ kind: "remote" });
  expect(f.calls).toEqual(["one"]);

  presentation.download(id("one"), false);
  await tick();
  expect(f.calls).toEqual(["one", "one"]);
  nextLookup = Promise.resolve(400);
  f.finish("one");
  await tick();
  expect(presentation.hasLocalFile(target)).toBe(true);
  unsubscribe();
  stop();
});

test("the document picker preserves confirmed local attachments and suspends chat actions", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create();
  const stop = manager.start();
  const attachment = source("one");
  const { target } = attachment;
  const key = id("one");
  const lease = {
    path: "/verified/file.jpg",
    lease: "picker-test-lease",
    name: "file.jpg",
    type: "image/jpeg",
  };
  const released: string[] = [];
  let checks = 0;
  let opens = 0;
  let interactive = true;
  let authorized = true;
  const presentation = createAttachmentPresentation(
    {
      retainedAttachmentBytes: async () => {
        checks++;
        return 400;
      },
      openAttachment: async () => {
        opens++;
        return lease;
      },
      releaseAttachment: async (value) => {
        released.push(value);
      },
    },
    manager,
    () => (authorized ? attachment : undefined),
    () => interactive,
  );
  const unsubscribe = presentation.subscribe(target, () => {});
  await tick();
  presentation.prepare(key);
  await tick();

  interactive = false;
  presentation.reconcile();
  expect(presentation.sourceFor(target)).toEqual(attachment);
  expect(presentation.authorize(target)).toBeUndefined();
  await presentation.useLocalFile(target, async () => {
    throw new Error("A hidden chat cannot open a file");
  });
  expect(presentation.state(key)).toEqual({ kind: "local", lease });
  expect(released).toEqual([]);

  interactive = true;
  presentation.reconcile();
  expect(presentation.authorize(target)).toEqual(attachment);
  expect(presentation.state(key)).toEqual({ kind: "local", lease });
  expect(checks).toBe(1);
  expect(opens).toBe(1);
  expect(f.calls).toEqual([]);

  authorized = false;
  presentation.reconcile();
  expect(presentation.hasLocalFile(target)).toBe(false);
  expect(released).toEqual([lease.lease]);
  unsubscribe();
  stop();
});

test("backgrounding aborts active work and foregrounding reconciles it before restarting", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create(1);
  const stop = manager.start();
  manager.enqueue(source("one"));
  manager.enqueue(source("two"));
  await tick();
  f.eligible(false);
  manager.sync();
  await tick();
  expect(f.calls).toEqual(["one"]);
  expect(f.store.load().find((job) => job.id === id("one"))).toMatchObject({
    state: "active",
  });
  expect(f.held.size).toBe(0);
  f.eligible(true);
  manager.sync();
  await tick();
  expect(f.calls).toEqual(["one", "one"]);
  expect(manager.get(id("one"))?.state).toBe("active");
  f.finish("one");
  await tick();
  expect(f.calls).toEqual(["one", "one", "two"]);
  f.finish("two");
  await tick();
  expect(manager.indicator()).toEqual({ selected: undefined, count: 0 });
  stop();
});

test("storage clear stops active work before clearing retained files and deletes durable history", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create(1);
  const stop = manager.start();
  manager.enqueue(source("one"));
  await tick();
  f.finish("one");
  await tick();
  manager.enqueue(source("two"));
  manager.enqueue(source("three"));
  await tick();
  await manager.clear(async () => {
    expect(f.held.size).toBe(0);
    expect(f.calls).toEqual(["one", "two"]);
  });
  expect(f.store.load()).toEqual([]);
  expect(manager.snapshot()).toEqual([]);
  stop();
});

test("startup restarts retained Blossom work in foreground and recovers completed files", async () => {
  using sqlite = new Database(":memory:");
  const { store } = fixture(sqlite);
  const http: BlossomDownload = {
    kind: "http",
    artifact: "blossom",
    hash: "a".repeat(64),
    expectedSize: null,
    total: null,
    name: "blob.bin",
    type: "application/octet-stream",
    urls: [],
    authors: [],
    expiresAt: null,
  };
  const row = {
    ...http,
    id: sourceId(http),
    state: "active",
    received: 0,
    retries: 0,
    retryAt: 0,
    order: 1,
    createdAt: 1,
    changedAt: 1,
  } as const;
  store.save([row]);
  const terminal = Promise.withResolvers<string>();
  const calls: string[] = [];
  let native = "downloading";
  const create = () =>
    createDownloadManager({
      store,
      eligible: () => true,
      authorized: () => true,
      transport: {
        async recover(sources) {
          calls.push(`discover:${sources[0]?.kind}`);
        },
        async status() {
          return native;
        },
        async control(_item, action) {
          calls.push(action);
        },
        async transfer() {
          calls.push("started");
          return terminal.promise;
        },
      },
    });
  const manager = create();
  manager.network(true, false);
  const stop = manager.start();
  await manager.reconcile();
  await tick();
  expect(calls).toEqual(["discover:http", "pause", "started"]);
  expect(manager.get(row.id)?.state).toBe("active");
  native = "ready";
  terminal.resolve("ready");
  await tick();
  expect(store.load()[0]?.state).toBe("completed");
  stop();
  store.save([row]);
  const reopened = create();
  const stopReopened = reopened.start();
  await reopened.reconcile();
  expect(reopened.get(row.id)?.state).toBe("completed");
  expect(calls).toEqual(["discover:http", "pause", "started", "discover:http"]);
  stopReopened();
});

test("a failed native cancellation leaves a durable intent for the next recovery", async () => {
  using sqlite = new Database(":memory:");
  const { store } = fixture(sqlite);
  const row = {
    ...source("one"),
    id: id("one"),
    state: "active",
    received: 4,
    retries: 0,
    retryAt: 0,
    order: 1,
    createdAt: 1,
    changedAt: 1,
  } as const;
  store.save([row]);
  let canCancel = false;
  let native = "downloading";
  const create = () =>
    createDownloadManager({
      store,
      eligible: () => true,
      authorized: () => true,
      transport: {
        async status() {
          return native;
        },
        async transfer(_item, _progress, signal) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return "interrupted";
        },
        async control() {
          if (!canCancel) throw new Error("Device busy");
          native = "cancelled";
        },
      },
    });
  const manager = create();
  const stop = manager.start();
  await manager.reconcile();
  await expect(manager.cancel(row.id)).rejects.toThrow("Device busy");
  expect(store.load()[0]).toMatchObject({ state: "active", intent: "cancel" });
  stop();
  canCancel = true;
  const reopened = create();
  const stopReopened = reopened.start();
  await reopened.reconcile();
  expect(store.load()[0]?.state).toBe("cancelled");
  expect(store.load()[0]?.intent).toBeUndefined();
  stopReopened();
});

test("removal during native discovery waits for the transfer before deleting its record", async () => {
  using sqlite = new Database(":memory:");
  const { store } = fixture(sqlite);
  const row = {
    ...source("one"),
    id: id("one"),
    state: "active",
    received: 0,
    retries: 0,
    retryAt: 0,
    order: 1,
    createdAt: 1,
    changedAt: 1,
  } as const;
  store.save([row]);
  const discovered = Promise.withResolvers<void>();
  const calls: string[] = [];
  const manager = createDownloadManager({
    store,
    eligible: () => true,
    authorized: () => true,
    transport: {
      async recover() {
        await discovered.promise;
        calls.push("discovered");
      },
      async status() {
        return "downloading";
      },
      async transfer() {
        calls.push("transfer");
        return "ready";
      },
      async control(_source, action) {
        calls.push(action);
      },
    },
  });
  const stop = manager.start();
  const remove = manager.remove(row.id);
  await tick();
  expect(store.load()[0]?.intent).toBe("remove");
  expect(calls).toEqual([]);
  discovered.resolve();
  await remove;
  expect(calls).toEqual(["discovered", "remove"]);
  expect(store.load()).toEqual([]);
  stop();
});

test("rapid background cycles drain attempts and preserve durable Blossom jobs", async () => {
  using sqlite = new Database(":memory:");
  const { store } = fixture(sqlite);
  const publicSource = (hash: string): BlossomDownload => ({
    kind: "http",
    artifact: "blossom",
    hash,
    expectedSize: null,
    total: null,
    name: "blob.bin",
    type: "application/octet-stream",
    urls: [],
    authors: [],
    expiresAt: null,
  });
  const first = publicSource("a".repeat(64));
  const second = publicSource("b".repeat(64));
  const order: string[] = [];
  const pending = new Map<string, (state: string) => void>();
  let eligible = true;
  const manager = createDownloadManager({
    store,
    concurrency: 1,
    eligible: () => eligible,
    authorized: () => true,
    transport: {
      async status() {
        return "unavailable";
      },
      async control() {},
      async transfer(source, progress, signal) {
        const id = sourceId(source);
        order.push(id);
        const { resolve, promise } = Promise.withResolvers<string>();
        pending.set(id, resolve);
        signal.addEventListener("abort", () => resolve("cancelled"), {
          once: true,
        });
        progress({ state: "downloading", received: 18, total: 24 });
        return promise;
      },
    },
  });
  const stop = manager.start();
  manager.enqueue(first);
  manager.enqueue(second);
  manager.enqueue({ ...second, urls: [`https://alt.cdn.org/${second.hash}`] });
  await tick();
  eligible = false;
  manager.sync();
  eligible = true;
  manager.sync();
  eligible = false;
  manager.sync();
  eligible = true;
  manager.sync();
  await tick();
  expect(order).toEqual([sourceId(first), sourceId(first)]);
  expect(store.load().find((job) => job.id === sourceId(first))).toMatchObject({
    state: "active",
  });
  expect(store.load().find((job) => job.id === sourceId(second))).toMatchObject(
    {
      state: "queued",
      urls: [`https://alt.cdn.org/${second.hash}`],
    },
  );
  pending.get(sourceId(first))?.("ready");
  await tick();
  expect(order).toEqual([sourceId(first), sourceId(first), sourceId(second)]);
  stop();
});

test("explicit pause and cancel survive manager restart", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create(2);
  const stop = manager.start();
  manager.enqueue(source("paused"));
  manager.enqueue(source("cancelled"));
  await tick();
  await manager.pause(id("paused"));
  await manager.cancel(id("cancelled"));
  expect(manager.get(id("paused"))?.state).toBe("paused");
  expect(manager.get(id("cancelled"))?.state).toBe("cancelled");
  stop();

  const reopened = f.create(2);
  const stopReopened = reopened.start();
  await tick();
  expect(reopened.get(id("paused"))?.state).toBe("paused");
  expect(reopened.get(id("cancelled"))?.state).toBe("cancelled");
  expect(f.calls).toEqual(["paused", "cancelled"]);
  stopReopened();
});
