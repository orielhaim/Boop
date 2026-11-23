import type {
  SpeechAvailability,
  SpeechTranscriber,
  SpeechTranscriberOptions,
  Transcript,
} from "@hzblj/expo-speech";
import { getLocales } from "expo-localization";
import { Platform } from "react-native";
import { type SpeechConfig, type SpeechPreferences, localeTag } from "./types";

const native = () => import("@hzblj/expo-speech");
const localOnly = { onDevice: true };
const permission = { microphone: false, speechRecognition: true };

async function query<T>(result: Promise<T>): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              Object.assign(new Error("Speech service did not respond"), {
                code: "start-timeout",
              }),
            ),
          15_000,
        );
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

export function speechError(error: unknown) {
  if (
    typeof error === "object" &&
    error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code
      .toLowerCase()
      .replace(/^err(?:or)?[_-](?:speech[_-])?/, "")
      .replaceAll("_", "-");
  }
  return "unknown";
}

function findLocale(candidate: string, supported: readonly string[]) {
  const normalized = candidate.toLowerCase();
  return (
    supported.find((locale) => locale.toLowerCase() === normalized) ??
    supported.find(
      (locale) =>
        locale.split("-")[0]?.toLowerCase() === normalized.split("-")[0],
    )
  );
}

export function createSpeechEngine() {
  let model: { key: string; engine: SpeechTranscriber } | undefined;
  let lastCapabilities: Promise<SpeechAvailability> | undefined;
  let catalog:
    { mode: SpeechConfig["mode"]; locales: Promise<string[]> } | undefined;
  const nativeAvailable = Platform.OS === "ios" || Platform.OS === "android";
  const options = (mode: SpeechConfig["mode"]) => ({ ...localOnly, mode });
  const capabilities = async () => {
    if (!nativeAvailable) return undefined;
    lastCapabilities ??= native()
      .then(({ Speech }) => query(Speech.getAvailabilityAsync(localOnly)))
      .catch((error) => {
        lastCapabilities = undefined;
        throw error;
      });
    return lastCapabilities;
  };
  const supported = async (mode: SpeechConfig["mode"]) => {
    if (!nativeAvailable) return [];
    if (catalog?.mode !== mode) {
      const locales = native()
        .then(({ Speech }) =>
          query(Speech.getSupportedLocalesAsync(options(mode))),
        )
        .then((values) =>
          values.filter((value) => localeTag.safeParse(value).success),
        )
        .catch((error) => {
          if (catalog?.locales === locales) catalog = undefined;
          throw error;
        });
      catalog = { mode, locales };
    }
    return catalog.locales;
  };
  const status = async (locale: string, mode: SpeechConfig["mode"]) =>
    query((await native()).Speech.getLocaleStatusAsync(locale, options(mode)));
  const install = async (
    locale: string,
    mode: SpeechConfig["mode"],
    onProgress?: (fraction: number) => void,
  ) => {
    const { Speech } = await native();
    await Speech.installLocaleAsync(locale, { ...options(mode), onProgress });
    catalog = undefined;
  };
  const release = () => {
    model?.engine.release();
    model = undefined;
  };
  return {
    capabilities,
    status,
    install,
    async models(mode: SpeechConfig["mode"]) {
      const capability = await capabilities();
      if (!capability?.fileTranscription || !capability.onDevice)
        return undefined;
      const { Speech } = await native();
      const [available, installed, reserved] = await Promise.all([
        supported(mode),
        Speech.getInstalledLocalesAsync(options(mode)),
        Speech.getReservedLocalesAsync(),
      ]);
      return {
        capability,
        available,
        installed,
        reserved,
        limit: Speech.maximumReservedLocales,
      };
    },
    async reserve(locale: string, reserve: boolean) {
      const { Speech } = await native();
      return reserve
        ? Speech.reserveLocaleAsync(locale)
        : Speech.releaseLocaleAsync(locale);
    },
    async configuration(
      preferences: SpeechPreferences,
      appLocale: string,
      override?: string,
    ): Promise<SpeechConfig | undefined> {
      const capability = await capabilities();
      if (!capability?.fileTranscription || !capability.onDevice)
        return undefined;
      const mode = preferences.recognitionMode;
      const { Speech } = await native();
      const all = await supported(mode);
      const installed = await Speech.getInstalledLocalesAsync(options(mode));
      const device = getLocales().map((item) => item.languageTag);
      const chosen = override ?? preferences.preferred;
      const candidates = [
        ...preferences.additional,
        ...device,
        appLocale,
        "en-US",
      ];
      const fallback = (locales: readonly string[]) =>
        candidates.map((locale) => findLocale(locale, locales)).find(Boolean);
      const locale = chosen
        ? findLocale(chosen, all)
        : (fallback(installed) ?? fallback(all) ?? installed[0] ?? all[0]);
      if (!locale) return undefined;
      const switches =
        capability.languageDetection && !chosen
          ? [
              ...new Set([
                locale,
                ...candidates
                  .slice(0, 7)
                  .flatMap((item) => findLocale(item, installed) ?? []),
              ]),
            ].slice(0, 5)
          : [];
      return {
        locale,
        switches,
        engine: capability.engine,
        mode,
        punctuation: preferences.punctuation,
        alternatives: preferences.alternatives,
        masking: preferences.masking,
        vocabulary: preferences.vocabulary
          .split(/[\n,]/)
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 40),
      };
    },
    async authorized(config: SpeechConfig) {
      return (
        config.engine !== "recognizer" ||
        (await (await native()).Speech.getPermissionsAsync(permission)).granted
      );
    },
    async requestPermission() {
      if ((await capabilities())?.engine !== "recognizer") return "granted";
      const { Speech } = await native();
      const current = await Speech.getPermissionsAsync(permission);
      if (current.granted) return "granted";
      if (!current.canAskAgain) return "settings";
      return (await Speech.requestPermissionsAsync(permission)).granted
        ? "granted"
        : "denied";
    },
    async transcribe(
      config: SpeechConfig,
      path: string,
      signal: AbortSignal,
      progress: (fraction: number) => void,
    ): Promise<Transcript> {
      const { SpeechTranscriber } = await native();
      signal.throwIfAborted();
      if (!path.startsWith("/")) throw new Error("Invalid local media path");
      const key = JSON.stringify(config);
      if (model?.key !== key) {
        release();
        const settings: SpeechTranscriberOptions = {
          locale: config.locale,
          mode: config.mode,
          onDevice: "required",
          maxConcurrent: 1,
          volatileResults: false,
          punctuation: config.punctuation,
          alternatives: config.alternatives,
          maskOffensiveWords: config.masking,
          contextualStrings: config.vocabulary,
          ios: {
            engine: "auto",
            modelRetention: "whileInUse",
            priority: "utility",
          },
          android: {
            feedSpeed: 4,
            biasingDeviceContext: false,
            languageDetection: config.switches.length
              ? { allowedLanguages: config.switches }
              : undefined,
            languageSwitch:
              config.switches.length > 1
                ? { mode: "highPrecision", allowedLanguages: config.switches }
                : undefined,
          },
        };
        model = { key, engine: new SpeechTranscriber(settings) };
      }
      const job = model.engine.transcribe(
        "file://" + path.split("/").map(encodeURIComponent).join("/"),
      );
      const cancel = () => job.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      const listener = job.addListener("progress", (event) => {
        if (event.phase === "transcribing") progress(event.fraction);
      });
      try {
        return await job.wait();
      } catch (error) {
        throw job.error ?? error;
      } finally {
        listener.remove();
        signal.removeEventListener("abort", cancel);
        job.release();
      }
    },
    release,
    async clearTemporary() {
      if (!nativeAvailable) return;
      const { Speech } = await native();
      await Speech.clearCacheAsync();
      await Speech.endModelRetentionAsync();
    },
  };
}
