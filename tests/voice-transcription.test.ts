import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { PlaybackFollower } from "../node_modules/@hzblj/expo-speech/build/playback";
import { createSpeechScheduler, priority } from "../src/core/speech/scheduler";
import {
  jobId,
  preferenceSchema,
  type SpeechConfig,
  type SpeechSource,
  validateTranscript,
} from "../src/core/speech/types";
import * as schema from "../src/db/schema";
import { speechStore } from "../src/db/speech";
import { initializeTestDatabase } from "./db-fixture";

const config: SpeechConfig = {
  locale: "he-IL",
  engine: "android",
  mode: "transcription",
  switches: [],
  punctuation: true,
  alternatives: false,
  masking: true,
  vocabulary: [],
};
const word = {
  text: "שלום",
  range: [0, 4],
  start: 0,
  end: 0.5,
  confidence: null,
  timing: "estimated",
};
const transcript = validateTranscript({
  text: word.text,
  locale: "he-IL",
  duration: 1,
  words: [word],
  segments: [
    {
      ...word,
      isFinal: true,
      words: [word],
      alternatives: [],
      language: "he-IL",
    },
  ],
});
const source = (id: string): SpeechSource => ({
  target: ["group", id, `event-${id}`, 0],
  sender: "peer",
  hash: "hash",
  incoming: true,
  expiresAt: null,
  duration: 2,
  sentAt: 1,
});

function setup(sqlite: Database) {
  initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  const store = speechStore(db, "alice");
  const key = randomBytes(32);
  const starts: string[] = [];
  const releases: string[] = [];
  const removed = new Set<string>();
  let block: Promise<void> | undefined;
  let allowed = true;
  let access = true;
  let mode = preferenceSchema.parse({ mode: "automatic" });
  const make = (account = "alice") =>
    createSpeechScheduler({
      account,
      store: speechStore(db, account),
      preferences: () => mode,
      canAccess: () => access,
      canRun: () => allowed,
      notify() {},
      errorCode: (error) =>
        error instanceof Error ? error.message : "unknown",
      async valid(item) {
        return !removed.has(item.target[1]);
      },
      async open(item) {
        const id = item.target[1];
        return { lease: id, path: `/verified/${id}`, type: "audio/mp4" };
      },
      async release(lease) {
        releases.push(lease);
      },
      backend: {
        async authorized() {
          return true;
        },
        async status() {
          return "installed";
        },
        async transcribe(_config, path, signal) {
          const id = path.split("/").at(-1) ?? "";
          starts.push(id);
          if (block) await block;
          signal.throwIfAborted();
          if (id === "broken") throw new Error("audio");
          if (id === "silence")
            return {
              text: "",
              locale: "he-IL",
              duration: 1,
              words: [],
              segments: [],
            };
          return transcript;
        },
        release() {},
      },
      encryption: {
        async seal(id, value) {
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(
            Buffer.from(id),
          );
          const bytes = Buffer.concat([
            cipher.update(JSON.stringify(value)),
            cipher.final(),
          ]);
          return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString(
            "base64",
          );
        },
        async open(id, value) {
          const bytes = Buffer.from(value, "base64");
          const decipher = createDecipheriv(
            "aes-256-gcm",
            key,
            bytes.subarray(0, 12),
          )
            .setAAD(Buffer.from(id))
            .setAuthTag(bytes.subarray(12, 28));
          return validateTranscript(
            JSON.parse(
              Buffer.concat([
                decipher.update(bytes.subarray(28)),
                decipher.final(),
              ]).toString(),
            ),
          );
        },
      },
    });
  return {
    make,
    store,
    starts,
    releases,
    removed,
    blockedUntil: (wait: Promise<void>) => {
      block = wait;
    },
    allow: (value: boolean) => {
      allowed = value;
    },
    active: (value: boolean) => {
      access = value;
    },
    off: () => {
      mode = { ...mode, mode: "off" };
    },
  };
}

async function until(check: () => boolean) {
  for (let turn = 0; turn < 100; turn += 1) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Speech worker did not settle");
}

test("starts one verified lease at a time, deduplicates work, and promotes foreground requests", async () => {
  using sqlite = new Database(":memory:");
  const fixture = setup(sqlite);
  const worker = fixture.make();
  const first = source("first");
  const old = source("old");
  const request = source("request");
  const gate = Promise.withResolvers<void>();
  fixture.blockedUntil(gate.promise);
  worker.sync();
  worker.enqueue(first, config, priority.download);
  worker.enqueue(first, config, priority.request);
  worker.enqueue(old, config, priority.retained);
  worker.enqueue(request, config, priority.request);
  await until(() => fixture.starts.length === 1);
  expect(fixture.starts).toEqual(["first"]);
  expect(fixture.releases).toEqual([]);
  gate.resolve();
  await until(() => fixture.releases.length === 3);
  expect(fixture.starts).toEqual(["first", "request", "old"]);
  expect(fixture.releases).toEqual(fixture.starts);
  expect(worker.view(first).transcript).toEqual(transcript);
  worker.enqueue(first, config, priority.request);
  await worker.drained();
  expect(fixture.starts).toHaveLength(3);
});

test("SQLite reopens encrypted final timings and reconciles interrupted work by account", async () => {
  using sqlite = new Database(":memory:");
  const fixture = setup(sqlite);
  const item = source("retained");
  const original = fixture.make();
  original.sync();
  original.enqueue(item, config, priority.request);
  await original.drained();
  expect(fixture.store.read(jobId("alice", item, config))).toBeString();
  expect(sqlite.serialize().includes(Buffer.from(transcript.text))).toBe(false);

  const restart = fixture.make();
  restart.sync();
  await restart.refresh(item);
  expect(restart.view(item).transcript).toEqual(transcript);
  expect(fixture.starts).toEqual(["retained"]);
  const otherAccount = fixture.make("bob");
  otherAccount.sync();
  await otherAccount.refresh(item);
  expect(otherAccount.view(item).transcript).toBeUndefined();

  const pending = source("interrupted");
  fixture.store.save({
    id: jobId("alice", pending, config),
    source: pending,
    config,
    status: "transcribing",
    priority: priority.download,
    attempts: 0,
    readyAt: 0,
    updated: Date.now(),
  });
  const recovered = fixture.make();
  recovered.sync();
  await recovered.drained();
  expect(fixture.starts).toEqual(["retained", "interrupted"]);
  expect(recovered.view(pending).job?.status).toBe("completed");
});

test("deletion, lock and disabling release leases and prevent stale writes", async () => {
  using sqlite = new Database(":memory:");
  const fixture = setup(sqlite);
  const worker = fixture.make();
  worker.sync();
  const item = source("locked");
  const gate = Promise.withResolvers<void>();
  fixture.blockedUntil(gate.promise);
  worker.enqueue(item, config, priority.request);
  await until(() => fixture.starts.length === 1);
  fixture.active(false);
  worker.sync();
  gate.resolve();
  await worker.drained();
  expect(fixture.store.read(jobId("alice", item, config))).toBeNull();
  expect(fixture.releases).toEqual(["locked"]);
  fixture.removed.add("locked");
  fixture.active(true);
  worker.sync();
  await worker.drained();
  expect(fixture.store.load()).toEqual([]);
  fixture.allow(false);
  worker.enqueue(source("pending"), config, priority.download);
  fixture.off();
  fixture.allow(true);
  worker.sync();
  expect(fixture.store.load()[0]?.status).toBe("cancelled");
  expect(fixture.starts).toEqual(["locked"]);
});

test("failed jobs leave the queue available and empty results are cached", async () => {
  using sqlite = new Database(":memory:");
  const fixture = setup(sqlite);
  const worker = fixture.make();
  const broken = source("broken");
  const silence = source("silence");
  worker.sync();
  worker.enqueue(broken, config, priority.request);
  worker.enqueue(silence, config, priority.download);
  await until(() => worker.view(silence).job?.status === "empty");
  worker.enqueue(silence, config, priority.request);
  await worker.drained();
  expect(worker.view(broken).job?.status).toBe("failed");
  expect(worker.view(silence).transcript?.text).toBe("");
  expect(fixture.starts).toEqual(["broken", "silence"]);
  expect(fixture.releases).toEqual(fixture.starts);
});

test("rejects invalid UTF-16 ranges, non-final segments and inconsistent times", () => {
  expect(() =>
    validateTranscript({ ...transcript, words: [{ ...word, range: [1, 4] }] }),
  ).toThrow();
  expect(() =>
    validateTranscript({
      ...transcript,
      segments: transcript.segments.map((part) => ({
        ...part,
        isFinal: false,
      })),
    }),
  ).toThrow();
  expect(() =>
    validateTranscript({
      ...transcript,
      duration: 0,
      words: [{ ...word, start: 1, end: 0 }],
    }),
  ).toThrow();
});

test("transcript follower uses playback rate, stops ticking when paused and resets after seeking", () => {
  let clock = 0;
  let timer: { at: number; tick: () => void } | undefined;
  const indexes: number[] = [];
  const follower = new PlaybackFollower(
    [
      { start: 0.1, end: 0.4 },
      { start: 0.5, end: 0.8 },
    ],
    (index) => indexes.push(index),
    {
      now: () => clock,
      setTimeout(tick, duration) {
        timer = { tick, at: clock + duration };
      },
      clearTimeout() {
        timer = undefined;
      },
    },
  );
  function advance(milliseconds: number) {
    const end = clock + milliseconds;
    while (timer && timer.at <= end) {
      const next = timer;
      clock = next.at;
      next.tick();
    }
    clock = end;
  }
  follower.report({ time: 0, rate: 2, playing: true });
  advance(60);
  expect(follower.currentIndex).toBe(0);
  advance(210);
  expect(follower.currentIndex).toBe(1);
  follower.report({ time: 0.54, playing: false });
  expect(timer).toBeUndefined();
  advance(500);
  expect(follower.currentIndex).toBe(1);
  follower.report({ time: 0 });
  expect(follower.currentIndex).toBe(-1);
  follower.report({ time: 0.8 });
  expect(follower.currentIndex).toBe(2);
  expect(indexes).toEqual([0, 1, -1, 2]);
  follower.dispose();
});
