import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { resources } from "./resources";

export const namespaces = [
  "common",
  "messenger",
  "navigation",
  "contacts",
  "messages",
  "calls",
  "video",
  "settings",
  "storage",
  "connections",
  "security",
  "errors",
  "chatKit",
  "translation",
  "speech",
  "downloads",
] as const satisfies readonly (keyof (typeof resources)["en"])[];

export const languages = ["en", "he"] as const;
export type AppLanguage = (typeof languages)[number];
export const languageChoices = ["auto", ...languages] as const;
export type LanguagePreference = (typeof languageChoices)[number];
export type LayoutDirection = "ltr" | "rtl";

export function resolveLanguage(value: unknown): AppLanguage {
  return value === "he" ? "he" : "en";
}

export function preferredLanguage(
  preference: LanguagePreference,
  deviceLanguage?: string | null,
): AppLanguage {
  if (preference !== "auto") return preference;
  const code = deviceLanguage?.split(/[-_]/, 1)[0]?.toLowerCase();
  return code === "he" || code === "iw" ? "he" : "en";
}

export function directionFor(language: AppLanguage): LayoutDirection {
  return language === "he" ? "rtl" : "ltr";
}

export const i18n = createInstance();

void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  supportedLngs: [...languages],
  resources,
  ns: [...namespaces],
  defaultNS: "common",
  initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
  ...(typeof __DEV__ !== "undefined" && __DEV__
    ? {
        saveMissing: true,
        missingKeyHandler: (
          _languages: readonly string[],
          namespace: string,
          key: string,
        ) => {
          console.warn(`Missing translation: ${namespace}:${key}`);
        },
      }
    : {}),
});
