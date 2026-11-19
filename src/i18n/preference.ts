import { preference, setPreference } from "@/db/queries";
import type { LanguagePreference } from "./index";

const key = "language";

export function readLanguagePreference<Result>(
  db: Parameters<typeof preference<Result>>[0],
  fallback: LanguagePreference = "auto",
): LanguagePreference {
  try {
    const value = preference(db, key);
    return value === "en" || value === "he" ? value : "auto";
  } catch {
    return fallback;
  }
}

export function saveLanguagePreference<Result>(
  db: Parameters<typeof setPreference<Result>>[0],
  language: LanguagePreference,
) {
  setPreference(db, key, language);
}
