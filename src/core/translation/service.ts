import type { TranslationCache } from "@/db/translations";

type MessageDirection = "incoming" | "outgoing";
type Message = { id: string; text: string; direction: MessageDirection };
export type TranslationOutcome =
  | { kind: "translated"; text: string }
  | { kind: "original" | "failed" | "unavailable" | "cancelled" }
  | { kind: "models"; languages: string[] };

export interface TranslationEngine {
  languages(): Promise<{ code: string; name: string }[]>;
  downloaded(): Promise<string[]>;
  identify(text: string): Promise<{
    language: string | null;
    confidence: number;
    candidates: { confidence: number }[];
  }>;
  translate(text: string, source: string, target: string): Promise<string>;
  download(language: string, wifiOnly: boolean): Promise<void>;
  remove(language: string): Promise<boolean>;
  reset(): void;
}

const languageAliases: Readonly<Record<string, string>> = {
  iw: "he",
  nb: "no",
  nn: "no",
  fil: "tl",
  in: "id",
};

export function languageCode(tag: string) {
  const code = tag.toLowerCase().replaceAll("_", "-");
  if (/^zh-(?:hant|tw|hk|mo)(?:-|$)/.test(code)) return "zh-hant";
  const base = code.split("-")[0] ?? "";
  return languageAliases[base] ?? base;
}

export function languageSample(text: string) {
  const sample = text
    .trim()
    .replace(
      /(?:\b(?:https?:\/\/|www\.|nostr:|npub1|nprofile1|nevent1|note1|nsec1)\S+)|(?:\b[\da-f]{32,}\b)|(?:\b[\w.+-]+@[\w.-]+\.\w+\b)/gi,
      " ",
    )
    .trim();
  if ((sample.match(/\p{L}/gu)?.length ?? 0) < 4) return null;
  // A message with substantial Hebrew and Latin text is unsafe to assign one source.
  if (
    /\p{Script=Hebrew}.*\p{Script=Hebrew}/su.test(sample) &&
    /\p{Script=Latin}.*\p{Script=Latin}/su.test(sample)
  )
    return null;
  return sample;
}

export function viewportMessages<T extends { direction: MessageDirection }>(
  items: readonly T[],
  visible: readonly number[],
) {
  const indexes = [...new Set(visible)]
    .filter((index) => index >= 0 && index < items.length)
    .sort((a, b) => a - b);
  return indexes
    .flatMap((index) => {
      const item = items[index];
      return item?.direction === "incoming" ? [item] : [];
    })
    .slice(0, 32);
}

export function createTranslationService(
  cache: TranslationCache,
  loadEngine: () => Promise<TranslationEngine>,
) {
  let native: Promise<TranslationEngine> | undefined;
  const engine = () =>
    (native ??= loadEngine().catch((error: unknown) => {
      native = undefined;
      throw error;
    }));
  let tail: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Promise<TranslationOutcome>>();
  const listeners = new Set<() => void>();
  let revision = 0;
  let generation = 0;
  const changed = () => {
    revision++;
    for (const listener of listeners) listener();
  };
  function serialize<T>(operation: () => Promise<T>) {
    const next = tail.then(operation);
    tail = next.catch(() => undefined);
    return next;
  }
  let downloading: string | undefined;
  let failedDownload: string | undefined;
  const isExcluded = (source: string, excludedSources: readonly string[]) =>
    excludedSources.includes(languageCode(source));

  const service = {
    cached(
      messages: Message[],
      target: string,
      excludedSources: readonly string[] = [],
    ) {
      const bodies = new Map(
        messages
          .filter(({ direction }) => direction === "incoming")
          .map(({ id, text }) => [id, text]),
      );
      return cache
        .read([...bodies.keys()], target)
        .filter(
          (row) =>
            bodies.get(row.messageId) === row.original &&
            !isExcluded(row.sourceLanguage, excludedSources),
        );
    },
    revision: () => revision,
    refreshModelStatus: changed,
    modelOperation: () => ({ downloading, failedDownload }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      generation++;
      cache.clear();
      if (native)
        void serialize(async () => (await engine()).reset()).catch(
          () => undefined,
        );
      changed();
    },
    refresh(id: string, target: string) {
      generation++;
      cache.remove(id, target);
      if (native)
        void serialize(async () => (await engine()).reset()).catch(
          () => undefined,
        );
      changed();
    },
    languages: async () => (await engine()).languages(),
    downloaded: async () => (await engine()).downloaded(),
    async download(language: string, wifiOnly: boolean) {
      if (downloading) return;
      downloading = language;
      failedDownload = undefined;
      changed();
      try {
        const worker = await engine();
        if (!(await worker.downloaded()).includes(language)) {
          await worker.download(language, wifiOnly);
        }
      } catch (error) {
        failedDownload = language;
        throw error;
      } finally {
        downloading = undefined;
        changed();
      }
    },
    remove: (language: string) =>
      serialize(async () => {
        if (downloading === language) return false;
        const removed = await (await engine()).remove(language);
        changed();
        return removed;
      }),
    async translate(
      message: Message,
      target: string,
      options: {
        signal?: AbortSignal;
        excludedSources?: readonly string[];
      } = {},
    ): Promise<TranslationOutcome> {
      const { signal, excludedSources = [] } = options;
      if (message.direction !== "incoming") return { kind: "original" };
      const version = generation;
      const sample = languageSample(message.text);
      if (!sample) return { kind: "original" };
      if (signal?.aborted || version !== generation)
        return { kind: "cancelled" };
      const key = JSON.stringify([
        message.id,
        target,
        message.text,
        version,
        excludedSources,
      ]);
      const running = pending.get(key);
      if (running) {
        const result = await running;
        return result.kind === "cancelled" && !signal?.aborted
          ? service.translate(message, target, options)
          : result;
      }
      const work = serialize(async (): Promise<TranslationOutcome> => {
        const cancelled = () => signal?.aborted || version !== generation;
        if (cancelled()) return { kind: "cancelled" };
        if (!cache.matchesIncoming(message.id, message.text)) {
          return { kind: "original" };
        }
        const [hit] = cache.read([message.id], target);
        if (hit)
          return isExcluded(hit.sourceLanguage, excludedSources)
            ? { kind: "original" }
            : { kind: "translated", text: hit.translatedText };
        const worker = await engine().catch(() => null);
        if (!worker) return { kind: "unavailable" };
        const detected = await worker.identify(sample);
        if (cancelled()) return { kind: "cancelled" };
        if (
          !detected.language ||
          detected.confidence < 0.72 ||
          detected.confidence - (detected.candidates[1]?.confidence ?? 0) < 0.2
        )
          return { kind: "original" };
        const source = languageCode(detected.language);
        if (source === target || isExcluded(source, excludedSources))
          return { kind: "original" };
        const supported = new Set(
          (await worker.languages()).map(({ code }) => code),
        );
        if (!supported.has(source) || !supported.has(target))
          return { kind: "original" };
        const installed = new Set(await worker.downloaded());
        const missing = [source, target].filter(
          (code) => code !== "en" && !installed.has(code),
        );
        if (missing.length) return { kind: "models", languages: missing };
        if (cancelled()) return { kind: "cancelled" };
        const text = await worker.translate(message.text, source, target);
        if (cancelled()) return { kind: "cancelled" };
        if (!text.trim() || text === message.text) return { kind: "original" };
        if (
          !cache.store(
            {
              messageId: message.id,
              sourceLanguage: source,
              targetLanguage: target,
              translatedText: text,
            },
            message.text,
          )
        ) {
          return { kind: "cancelled" };
        }
        return { kind: "translated", text };
      })
        .catch((): TranslationOutcome => ({ kind: "failed" }))
        .finally(() => pending.delete(key));
      pending.set(key, work);
      return work;
    },
  };
  return service;
}
