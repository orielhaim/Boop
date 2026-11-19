import type { TranslationEngine } from "./service";
import { languageCode } from "./service";

export async function loadTranslationEngine(): Promise<TranslationEngine> {
  const { Translation, Translator } = await import("@hzblj/expo-translation");
  const ios = { engine: "mlkit" } as const;
  const availability = await Translation.getAvailabilityAsync();
  if (!availability.engines.includes("mlkit"))
    throw new Error("mlkit-unavailable");

  let supported: ReturnType<TranslationEngine["languages"]> | undefined;
  return {
    languages() {
      supported ??= (async () => {
        const options = await Translation.getSupportedLanguagesAsync();
        const codes = [
          ...new Set(options.map(({ language }) => languageCode(language))),
        ];
        // On iOS the native catalog also includes Apple's languages. Check the
        // selected engine explicitly, because the catalog merges shared entries.
        const pairs = await Promise.all(
          codes.map(async (code) => ({
            code,
            supported:
              code === "en" ||
              options.some(
                (option) =>
                  option.engine === "mlkit" &&
                  languageCode(option.language) === code,
              ) ||
              (await Translation.getStatusAsync({ from: "en", to: code, ios }))
                .engine === "mlkit",
          })),
        );
        return pairs
          .filter((pair) => pair.supported)
          .map(({ code }) => ({
            code,
            name: Translation.languageName(code),
          }));
      })().catch((error: unknown) => {
        supported = undefined;
        throw error;
      });
      return supported;
    },
    async downloaded() {
      return [
        "en",
        ...(await Translation.getDownloadedLanguagesAsync()).map(languageCode),
      ];
    },
    identify: (text) => Translation.identifyLanguageAsync(text),
    async translate(text, source, target) {
      const translator = new Translator({
        from: source,
        to: target,
        ios,
        download: false,
      });
      try {
        const result = await translator.translateAsync(text);
        if (
          result.engine !== "mlkit" ||
          languageCode(result.sourceLanguage) !== source ||
          languageCode(result.targetLanguage) !== target
        )
          throw new Error("invalid-translation");
        return result.text;
      } finally {
        translator.release();
        Translation.clearCache();
      }
    },
    download: (language, wifiOnly) =>
      Translation.downloadAsync({ from: "en", to: language, ios, wifiOnly }),
    remove: (language) => Translation.deleteDownloadedLanguageAsync(language),
    reset: Translation.clearCache,
  };
}
