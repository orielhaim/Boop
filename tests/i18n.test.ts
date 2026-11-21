import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createInstance } from "i18next";
import { initializeTestDatabase } from "./db-fixture";
import { setPreference } from "../src/db/queries";
import * as schema from "../src/db/schema";
import {
  directionFor,
  i18n,
  languageChoices,
  languages,
  namespaces,
  preferredLanguage,
  resolveLanguage,
} from "../src/i18n";
import { formatDuration, isolateText } from "../src/i18n/format";
import nativeEnglish from "../src/i18n/locales/native-en.json";
import nativeHebrew from "../src/i18n/locales/native-he.json";
import {
  readLanguagePreference,
  saveLanguagePreference,
} from "../src/i18n/preference";
import { resources } from "../src/i18n/resources";

type Bundle = { readonly [key: string]: string | Bundle };

function flatten(bundle: Bundle, prefix = ""): [string, string][] {
  return Object.entries(bundle).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [[path, value]] : flatten(value, path);
  });
}

function parameters(text: string) {
  return [
    ...new Set(
      [...text.matchAll(/\{\{\s*(\w+)(?:,[^}]+)?\s*\}\}|\{(\w+)\}/g)].map(
        (match) => match[1] ?? match[2],
      ),
    ),
  ].sort();
}

test("both languages match namespace, key shape and interpolation with valid CLDR plurals", () => {
  expect(Object.keys(resources)).toEqual([...languages]);
  expect(Object.keys(resources.en).sort()).toEqual([...namespaces].sort());
  const english = new Map(flatten(resources.en));
  const hebrew = new Map(flatten(resources.he));
  const plural = /_(zero|one|two|few|many|other)$/;
  const baseKeys = (entries: Map<string, string>) =>
    [
      ...new Set([...entries.keys()].map((key) => key.replace(plural, ""))),
    ].sort();
  expect(baseKeys(hebrew)).toEqual(baseKeys(english));

  for (const language of languages) {
    const entries = language === "en" ? english : hebrew;
    const categories = new Intl.PluralRules(language).resolvedOptions()
      .pluralCategories;
    for (const [key, copy] of entries) {
      expect(copy.trim()).not.toBe("");
      const match = key.match(plural);
      if (match) {
        expect(categories.some((category) => category === match[1])).toBe(true);
        const base = key.replace(plural, "");
        for (const category of categories)
          expect(entries.has(`${base}_${category}`)).toBe(true);
        for (const check of [english, hebrew]) {
          const other = check.get(`${base}_other`);
          expect(other).toBeDefined();
          // Singular and dual forms can spell out the number.
          expect(parameters(copy).filter((name) => name !== "count")).toEqual(
            parameters(other ?? "").filter((name) => name !== "count"),
          );
        }
      } else {
        const other = (language === "en" ? hebrew : english).get(key);
        expect(other).toBeDefined();
        expect(parameters(copy)).toEqual(parameters(other ?? ""));
      }
    }
  }
  expect(Object.keys(nativeHebrew.ios).sort()).toEqual(
    Object.keys(nativeEnglish.ios).sort(),
  );
  expect(
    Object.values(nativeHebrew.ios).every((copy) => /[א-ת]/.test(copy)),
  ).toBe(true);
});

test("i18next starts with bundled English fallback and Hebrew controls direction", () => {
  expect(resolveLanguage(null)).toBe("en");
  expect(resolveLanguage("iw")).toBe("en");
  expect(resolveLanguage("he-IL")).toBe("en");
  expect(directionFor(resolveLanguage("en"))).toBe("ltr");
  expect(directionFor(resolveLanguage("he"))).toBe("rtl");
  expect(i18n.resolvedLanguage).toBe("en");
  expect<string>(i18n.t("unlock", { ns: "security", lng: "he" })).toBe(
    "ביטול נעילה",
  );
  expect<string>(
    i18n.t("selected", { ns: "connections", lng: "he", count: 2 }),
  ).toBe("שני ממסרים נבחרו");
  expect<string>(
    i18n.t("selected", { ns: "connections", lng: "en", count: 1 }),
  ).toBe("1 selected");
  expect<string>(
    i18n.t("selected", { ns: "connections", lng: "he", count: 5 }),
  ).toBe("5 ממסרים נבחרו");
  expect<string>(i18n.t("close", { lng: "fr" })).toBe("Close");
  const chat = i18n.getFixedT("he", "chatKit")("labels", {
    returnObjects: true,
  });
  expect<string>(chat.placeholder).toBe("כתיבת הודעה");
  expect(chat.replyingTo).toContain("{name}");
});

test("falls back to English when a Hebrew value is absent", async () => {
  const instance = createInstance();
  await instance.init({
    lng: "he",
    fallbackLng: "en",
    defaultNS: "common",
    supportedLngs: [...languages],
    resources: { en: { common: { close: "Close" } }, he: { common: {} } },
  });
  expect(instance.t("close")).toBe("Close");
});

test("Auto-detect follows the primary supported locale and manual choices win", () => {
  expect([...languageChoices]).toEqual(["auto", "en", "he"]);
  expect(preferredLanguage("auto", "he-IL")).toBe("he");
  expect(preferredLanguage("auto", "iw")).toBe("he");
  expect(preferredLanguage("auto", "en-GB")).toBe("en");
  expect(preferredLanguage("auto", "ar")).toBe("en");
  expect(preferredLanguage("auto")).toBe("en");
  expect(preferredLanguage("en", "he")).toBe("en");
  expect(preferredLanguage("he", "en")).toBe("he");
});

test("SQLite app language survives reader replacement and tolerates invalid or failed reads", () => {
  using sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
  const open = () => drizzle(sqlite, { schema });
  expect(readLanguagePreference(open())).toBe("auto");
  expect(preferredLanguage(readLanguagePreference(open()), "he-IL")).toBe("he");
  expect(preferredLanguage(readLanguagePreference(open()), "fr-FR")).toBe("en");
  saveLanguagePreference(open(), "he");
  expect(readLanguagePreference(open())).toBe("he");
  saveLanguagePreference(open(), "auto");
  expect(readLanguagePreference(open())).toBe("auto");
  saveLanguagePreference(open(), "en");
  expect(readLanguagePreference(open())).toBe("en");
  setPreference(open(), "language", "fr");
  expect(readLanguagePreference(open())).toBe("auto");
  expect(
    readLanguagePreference({
      select: () => {
        throw new Error("unavailable");
      },
      insert: open().insert,
    }),
  ).toBe("auto");
});

test("duration and mixed-direction labels keep technical data legible", () => {
  expect(formatDuration(222)).toBe("03:42");
  expect(formatDuration(3601)).toBe("01:00:01");
  expect(
    i18n.t("wants", { ns: "video", lng: "he", name: isolateText("Alice") }),
  ).toContain("\u2068Alice\u2069");
});
