import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  createTranslationService,
  languageSample,
  type TranslationEngine,
  viewportMessages,
} from "../src/core/translation/service";
import { initializeTestDatabase } from "./db-fixture";
import * as schema from "../src/db/schema";
import { createDerivedTranslations } from "../src/db/translations";

const message = {
  id: "local",
  text: "נתראה מחר בבוקר",
  direction: "incoming",
} as const;

function database(sqlite: Database, migrate = true) {
  if (migrate) initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  const incoming = new Map<string, string>([[message.id, message.text]]);
  return {
    incoming,
    cache: createDerivedTranslations(db, (id) => incoming.get(id)),
  };
}

function engine(overrides: Partial<TranslationEngine> = {}) {
  let calls = 0;
  const worker = {
    languages: async () =>
      ["en", "he", "fr"].map((code) => ({ code, name: code })),
    downloaded: async () => ["en", "he", "fr"],
    identify: async () => ({
      language: "iw-IL",
      confidence: 0.97,
      candidates: [{ confidence: 0.97 }],
    }),
    translate: async (_text, _source, target) => {
      calls++;
      return target === "fr" ? "À demain matin" : "See you tomorrow morning";
    },
    download: async () => undefined,
    remove: async () => true,
    reset: () => undefined,
    ...overrides,
  } satisfies TranslationEngine;
  return { worker, calls: () => calls };
}

test("skips non-language and mixed Hebrew/English while leaving ordinary Hebrew identifiable", () => {
  for (const text of [
    "  ",
    "👋 🧑🏽‍💻",
    "https://example.org/address",
    "npub1example567",
    "123-555-4321",
    "שלום, see you tomorrow",
  ]) {
    expect(languageSample(text)).toBeNull();
  }
  expect(languageSample("נתראה מחר בבוקר https://example.org")).toBe(
    message.text,
  );
});

test("deduplicates concurrent translation and persists per language", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boop-translation-"));
  try {
    const file = join(directory, "cache.db");
    {
      using sqlite = new Database(file);
      const { cache } = database(sqlite);
      const mock = engine();
      const service = createTranslationService(cache, async () => mock.worker);
      const translated = {
        kind: "translated",
        text: "See you tomorrow morning",
      } as const;
      expect(
        await Promise.all([
          service.translate(message, "en"),
          service.translate(message, "en"),
        ]),
      ).toEqual([translated, translated]);
      expect(mock.calls()).toBe(1);
      expect(await service.translate(message, "fr")).toEqual({
        kind: "translated",
        text: "À demain matin",
      });
      expect(await service.translate(message, "en")).toEqual(translated);
      expect(mock.calls()).toBe(2);
      expect(service.cached([message], "fr")[0]?.translatedText).toBe(
        "À demain matin",
      );
    }
    {
      using sqlite = new Database(file);
      const { cache } = database(sqlite, false);
      let engineLoaded = false;
      const service = createTranslationService(cache, async () => {
        engineLoaded = true;
        throw new Error("offline");
      });
      expect(await service.translate(message, "en")).toEqual({
        kind: "translated",
        text: "See you tomorrow morning",
      });
      expect(engineLoaded).toBe(false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalidation and deletion remove stale translations and reject stale writes", async () => {
  using sqlite = new Database(":memory:");
  const { cache, incoming } = database(sqlite);
  const mock = engine();
  const service = createTranslationService(cache, async () => mock.worker);
  await service.translate(message, "en");
  service.refresh(message.id, "en");
  expect(cache.read([message.id], "en")).toEqual([]);
  await service.translate(message, "en");
  expect(mock.calls()).toBe(2);
  incoming.set(message.id, "נתראה בקרוב");
  expect(cache.read([message.id], "en")).toEqual([]);
  expect(await service.translate(message, "en")).toEqual({ kind: "original" });
  await service.translate({ ...message, text: "נתראה בקרוב" }, "en");
  expect(cache.read([message.id], "en")).toHaveLength(1);
  incoming.delete(message.id);
  expect(cache.read([message.id], "en")).toEqual([]);
});

test("source confidence, unsupported and missing models leave the original", async () => {
  using sqlite = new Database(":memory:");
  const { cache } = database(sqlite);
  const mock = engine({ downloaded: async () => ["en"] });
  const service = createTranslationService(cache, async () => mock.worker);
  expect(await service.translate(message, "he")).toEqual({ kind: "original" });
  expect(await service.translate(message, "eo")).toEqual({ kind: "original" });
  expect(await service.translate(message, "en")).toEqual({
    kind: "models",
    languages: ["he"],
  });
  const weak = engine({
    identify: async () => ({
      language: "he",
      confidence: 0.55,
      candidates: [],
    }),
  });
  expect(
    await createTranslationService(cache, async () => weak.worker).translate(
      message,
      "en",
    ),
  ).toEqual({ kind: "original" });
  expect(mock.calls()).toBe(0);
  const failure = engine({
    translate: async () => {
      throw new Error("native failure");
    },
  });
  expect(
    await createTranslationService(cache, async () => failure.worker).translate(
      message,
      "en",
    ),
  ).toEqual({ kind: "failed" });
  expect(cache.read([message.id], "en")).toEqual([]);
});

test("cancelled and cleared in-flight operations cannot commit a result", async () => {
  using sqlite = new Database(":memory:");
  const { cache } = database(sqlite);
  const begun = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<string>();
  const mock = engine({
    translate: async () => {
      begun.resolve();
      return finish.promise;
    },
  });
  const service = createTranslationService(cache, async () => mock.worker);
  const cancel = new AbortController();
  const work = service.translate(message, "en", cancel.signal);
  await begun.promise;
  cancel.abort();
  service.clear();
  finish.resolve("See you tomorrow morning");
  expect(await work).toEqual({ kind: "cancelled" });
  expect(cache.read([message.id], "en")).toEqual([]);
  expect(await service.translate(message, "en")).toMatchObject({
    kind: "translated",
  });
});

test("outgoing messages never reach the translation engine or use unauthorized cache rows", async () => {
  using sqlite = new Database(":memory:");
  const { cache, incoming } = database(sqlite);
  const outgoing = { ...message, direction: "outgoing" } as const;
  incoming.delete(message.id);
  const invalidRow = {
    messageId: outgoing.id,
    sourceLanguage: "he",
    targetLanguage: "en",
    translatedText: "See you tomorrow morning",
  };
  expect(cache.store(invalidRow, outgoing.text)).toBe(false);

  let engineLoaded = false;
  const service = createTranslationService(cache, async () => {
    engineLoaded = true;
    return engine().worker;
  });
  expect(await service.translate(outgoing, "en")).toEqual({ kind: "original" });
  expect(await service.translate(message, "en")).toEqual({ kind: "original" });
  expect(engineLoaded).toBe(false);
  expect(await service.cached([outgoing], "en")).toEqual([]);
});

test("a bounded conversation viewport schedules only visible incoming rows", () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    text: message.text,
    direction: index % 2 ? ("incoming" as const) : ("outgoing" as const),
  }));
  expect(viewportMessages(rows, [])).toEqual([]);
  expect(viewportMessages(rows, [88, 89, 90, 91]).map((row) => row.id)).toEqual(
    ["89", "91"],
  );
});
