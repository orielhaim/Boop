import { eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { useMemo } from "react";
import type { Database } from "@/db";
import { preference, setPreference } from "@/db/queries";
import { settings } from "@/db/schema";
import type { AppLanguage } from "@/i18n";

const preferenceKey = "chats.translation";
type TranslationPreferences = { automatic: boolean; target: string };

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
    /^[a-z]{2,3}(?:-[a-z]{2,8})?$/.test(saved.target)
  ) {
    return {
      automatic: "automatic" in saved && saved.automatic === true,
      target: saved.target,
    };
  }
  return { automatic: false, target: language };
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
