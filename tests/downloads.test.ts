import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  createDownloadManager,
  type TransferProgress,
} from "../src/core/downloads/manager";
import { downloadId, type DownloadSource } from "../src/core/downloads/types";
import { createAttachmentPresentation } from "../src/core/marmot/attachment-presentation";
import { downloadStore } from "../src/db/downloads";
import * as schema from "../src/db/schema";
import { initializeTestDatabase } from "./db-fixture";

const source = (id: string, hash?: string): DownloadSource => ({
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
      eligible: () => eligible,
      authorized: () => authorized,
      completed: (item) => completed.push(item.target[1]),
      transport: {
        async status(target) {
          return statuses.get(target[1]) ?? "not_requested";
        },
        async control(target, action) {
          statuses.set(
            target[1],
            action === "cancel" ? "cancelled" : "removed",
          );
          return true;
        },
        async transfer(target, progress, signal) {
          const name = target[1];
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

test("pause and cancel stop the native attempt, while a successful cancel race preserves a ready file", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create(1);
  const stop = manager.start();
  manager.enqueue(source("one"));
  await tick();
  await manager.pause(id("one"));
  expect(manager.get(id("one"))?.state).toBe("paused");
  expect(f.held.size).toBe(0);
  manager.resume(id("one"));
  await tick();
  f.finish("one");
  await manager.cancel(id("one"));
  expect(manager.get(id("one"))?.state).toBe("completed");
  await manager.remove(id("one"));
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
      attachmentStatus: async () => f.statuses.get("one") === "ready",
      openAttachment: async () =>
        f.statuses.get("one") === "ready" ? local : null,
      releaseAttachment: async (lease) => {
        released.push(lease);
      },
    },
    manager,
    () => source("one"),
  );
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
  expect(presentation.state(id("one"))).toEqual({ kind: "cached" });
  presentation.prepare(id("one"));
  await tick();
  expect(presentation.state(id("one"))).toEqual({
    kind: "local",
    lease: local,
  });
  reopened();
  expect(released).toEqual(["lease"]);
  stop();
});

test("an admitted transfer can finish while new work waits for the protected session", async () => {
  using sqlite = new Database(":memory:");
  const f = fixture(sqlite);
  const manager = f.create(1);
  const stop = manager.start();
  manager.enqueue(source("one"));
  manager.enqueue(source("two"));
  await tick();
  f.eligible(false);
  manager.sync();
  f.finish("one");
  await tick();
  expect(f.calls).toEqual(["one"]);
  expect(manager.indicator().selected?.id).toBe(id("two"));
  expect(manager.indicator().count).toBe(1);
  f.eligible(true);
  manager.sync();
  await tick();
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
