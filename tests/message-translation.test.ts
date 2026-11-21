import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  createTranslationService,
  languageSample,
  type TranslationEngine,
  viewportMessages,
} from "../src/core/translation/service";
import { seedStressConversations, stressPeerKey } from "./chat-fixture";
import { createMessagingRepository } from "../src/db/messaging";
import { initializeTestDatabase } from "./db-fixture";
import * as schema from "../src/db/schema";
import { createTranslationCache } from "../src/db/translations";

const message = {
  id: "local",
  text: "נתראה מחר בבוקר",
  direction: "incoming",
} as const;
const input = {
  id: message.id,
  body: message.text,
  peerKey: "peer",
  direction: "incoming",
  eventId: "inner-rumor",
  sentAt: 42,
  replyTo: null,
  senderKey: "peer",
  recipientKey: "self",
} as const;

function database(sqlite: Database, migrate = true) {
  if (migrate) initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  return {
    db,
    cache: createTranslationCache(db),
    chat: createMessagingRepository(db),
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

test("deduplicates concurrent translation and gift wraps, persists per language and supplies cached previews", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boop-translation-"));
  try {
    const file = join(directory, "cache.db");
    {
      using sqlite = new Database(file);
      const { chat, cache } = database(sqlite);
      const mock = engine();
      const service = createTranslationService(cache, async () => mock.worker);
      expect(chat.receive(input)).toBe(true);
      expect(chat.receive({ ...input, id: "different-gift-wrap" })).toBe(false);
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
      expect(chat.conversations({ translationTarget: "fr" })[0]).toMatchObject({
        preview: message.text,
        translatedPreview: "À demain matin",
      });
    }
    {
      using sqlite = new Database(file);
      const { chat, cache } = database(sqlite, false);
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
      expect(chat.message("peer", message.id)?.body).toBe(message.text);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalidation and deletion remove stale translations and reject stale writes", async () => {
  using sqlite = new Database(":memory:");
  const { chat, cache, db } = database(sqlite);
  const mock = engine();
  const service = createTranslationService(cache, async () => mock.worker);
  chat.receive(input);
  await service.translate(message, "en");
  service.refresh(message.id, "en");
  expect(cache.read([message.id], "en")).toEqual([]);
  await service.translate(message, "en");
  expect(mock.calls()).toBe(2);
  db.update(schema.messages)
    .set({ body: "נתראה בקרוב" })
    .where(eq(schema.messages.id, message.id))
    .run();
  expect(cache.read([message.id], "en")).toEqual([]);
  expect(await service.translate(message, "en")).toEqual({ kind: "original" });
  await service.translate({ ...message, text: "נתראה בקרוב" }, "en");
  expect(cache.read([message.id], "en")).toHaveLength(1);
  chat.deleteMessages("peer", [message.id]);
  expect(cache.read([message.id], "en")).toEqual([]);
});

test("source confidence, unsupported and missing models leave the original", async () => {
  using sqlite = new Database(":memory:");
  const { chat, cache } = database(sqlite);
  chat.receive(input);
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
  const { chat, cache } = database(sqlite);
  chat.receive(input);
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
  const { chat, db, cache } = database(sqlite);
  const outgoing = { ...message, direction: "outgoing" } as const;
  chat.enqueue({
    ...input,
    direction: "outgoing",
    senderKey: "self",
    recipientKey: "peer",
  });
  const invalidRow = {
    messageId: outgoing.id,
    sourceLanguage: "he",
    targetLanguage: "en",
    translatedText: "See you tomorrow morning",
  };
  expect(cache.store(invalidRow, outgoing.text)).toBe(false);
  db.insert(schema.messageTranslations).values(invalidRow).run();

  let engineLoaded = false;
  const service = createTranslationService(cache, async () => {
    engineLoaded = true;
    return engine().worker;
  });
  expect(await service.translate(outgoing, "en")).toEqual({ kind: "original" });
  expect(await service.translate(message, "en")).toEqual({ kind: "original" });
  expect(engineLoaded).toBe(false);
  expect(await service.cached([outgoing], "en")).toEqual([]);
  expect(chat.conversations({ translationTarget: "en" })[0]).toMatchObject({
    preview: outgoing.text,
    translatedPreview: null,
  });
});

test("a 10,000-message chat schedules only visible incoming rows", () => {
  using sqlite = new Database(":memory:");
  const { chat, db } = database(sqlite);
  seedStressConversations(db, "self");
  expect(
    sqlite
      .query("SELECT count(*) AS n FROM messages WHERE peer_key = ?")
      .get(stressPeerKey),
  ).toEqual({ n: 10_000 });
  const opening = chat.history(stressPeerKey, { limit: 100 });
  expect(opening.messages).toHaveLength(100);
  expect(viewportMessages(opening.messages, [])).toHaveLength(0);
  const visible = [88, 89, 90, 91, 92, 93, 94, 95];
  const work = viewportMessages(opening.messages, visible);
  expect(work).toEqual(
    opening.messages
      .slice(88, 96)
      .filter(({ direction }) => direction === "incoming"),
  );
  expect(work.length).toBeGreaterThan(0);
  expect(work.length).toBeLessThan(8);
});
