import { eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { useMemo } from "react";
import type { Database } from "@/db";
import { preference, setPreference } from "@/db/queries";
import { settings } from "@/db/schema";
import type { AppLanguage } from "@/i18n";
import { languageCode } from "./service";

const preferenceKey = "chats.translation";
type TranslationPreferences = {
  automatic: boolean;
  target: string;
  excludedSources: string[];
};

const languageTag = /^[a-z]{2,3}(?:-[a-z]{2,8})?$/;

function parse(
  value: string | null | undefined,
  language: AppLanguage,
): TranslationPreferences {
  let saved: unknown;
  try {
    saved = value ? JSON.parse(value) : null;
  } catch {
    saved = null;
  }
  if (
    saved &&
    typeof saved === "object" &&
    "target" in saved &&
    typeof saved.target === "string" &&
    languageTag.test(saved.target)
  ) {
    const excluded = "excludedSources" in saved ? saved.excludedSources : null;
    return {
      automatic: "automatic" in saved && saved.automatic === true,
      target: saved.target,
      excludedSources: Array.isArray(excluded)
        ? [
            ...new Set(
              excluded.flatMap((tag: unknown) =>
                typeof tag === "string" && languageTag.test(tag)
                  ? [languageCode(tag)]
                  : [],
              ),
            ),
          ].sort()
        : [],
    };
  }
  return { automatic: false, target: language, excludedSources: [] };
}

export function initializeTranslationPreferences(
  db: Database,
  language: AppLanguage,
) {
  if (preference(db, preferenceKey) === null) {
    setTranslationPreferences(db, parse(null, language));
  }
}

export function translationPreviewTarget(db: Database) {
  const { automatic, target } = parse(preference(db, preferenceKey), "en");
  return automatic ? target : undefined;
}

export function useTranslationPreferences(db: Database, language: AppLanguage) {
  const query = useMemo(
    () => db.select().from(settings).where(eq(settings.key, preferenceKey)),
    [db],
  );
  const { data } = useLiveQuery(query, [query]);
  const value = data[0]?.value;
  return useMemo(() => parse(value, language), [value, language]);
}

export function setTranslationPreferences(
  db: Database,
  value: TranslationPreferences,
) {
  setPreference(db, preferenceKey, JSON.stringify(value));
}

export function toggleExcludedSource(
  db: Database,
  language: AppLanguage,
  code: string,
) {
  const preferences = parse(preference(db, preferenceKey), language);
  const excluded = new Set(preferences.excludedSources);
  const source = languageCode(code);
  if (excluded.has(source)) excluded.delete(source);
  else excluded.add(source);
  setTranslationPreferences(db, {
    ...preferences,
    excludedSources: [...excluded].sort(),
  });
}
