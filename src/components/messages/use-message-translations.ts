import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState } from "react-native";
import { useTranslationPreferences } from "@/core/translation/preferences";
import {
  type TranslationOutcome,
  viewportMessages,
} from "@/core/translation/service";
import { resolveLanguage } from "@/i18n";
import { useLocal } from "@/services/local-context";
type TranslationMessage = {
  _id: string;
  text: string;
  direction: "incoming" | "outgoing";
  locked?: unknown;
  originalText?: string;
};

const maxRemembered = 120;
const emptyOutcomes = new Map<string, TranslationOutcome>();
const messageKey = (message: TranslationMessage) =>
  JSON.stringify([message._id, message.text]);

function subscribeAppState(listener: () => void) {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}

export function useMessageTranslations<T extends TranslationMessage>(
  items: T[],
  visibleIds: readonly string[],
  language: string,
  focused: boolean,
) {
  const { db, translation, lock } = useLocal();
  const settings = useTranslationPreferences(db, resolveLanguage(language));
  const revision = useSyncExternalStore(
    translation.subscribe,
    translation.revision,
  );
  const locked = useSyncExternalStore(lock.subscribe, lock.getState).locked;
  const active =
    useSyncExternalStore(subscribeAppState, () => AppState.currentState) ===
    "active";
  const [attempt, setAttempt] = useState(0);
  const { excludedSources } = settings;
  const scope = JSON.stringify([
    settings.target,
    excludedSources,
    revision,
    attempt,
  ]);
  const [results, setResults] = useState({ scope: "", entries: emptyOutcomes });
  const [originals, setOriginals] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const outcomes = results.scope === scope ? results.entries : emptyOutcomes;

  // Scope the work by stable IDs and bodies. Read receipts, reactions and
  // pagination can change the row objects without invalidating a translation.
  const viewport = useMemo(() => {
    if (!settings.automatic || !focused || !active || locked) return [];
    const visible = new Set(visibleIds);
    const indexes = items.flatMap(({ _id, locked }, index) =>
      !locked && visible.has(_id) ? [index] : [],
    );
    return viewportMessages(items, indexes).map(({ _id, text, direction }) => ({
      id: _id,
      text,
      direction,
    }));
  }, [items, visibleIds, settings.automatic, focused, active, locked]);
  const viewportKey = useMemo(
    () => (viewport.length ? JSON.stringify([visibleIds, viewport]) : ""),
    [visibleIds, viewport],
  );
  const snapshot = useEffectEvent(() => ({
    tasks: viewport,
    outcomes,
  }));

  useEffect(() => {
    if (!viewportKey) return;
    const { tasks, outcomes } = snapshot();
    const controller = new AbortController();
    const { signal } = controller;
    const store = (batch: Map<string, TranslationOutcome>) => {
      if (!batch.size || signal.aborted) return;
      setResults((previous) => {
        const entries = new Map(
          previous.scope === scope ? previous.entries : [],
        );
        for (const [key, value] of batch) {
          entries.delete(key);
          entries.set(key, value);
        }
        while (entries.size > maxRemembered) {
          const first = entries.keys().next().value;
          if (first === undefined) break;
          entries.delete(first);
        }
        return { scope, entries };
      });
    };
    void (async () => {
      const cached = new Map(
        translation
          .cached(tasks, settings.target, excludedSources)
          .map((row) => [row.messageId, row.translatedText]),
      );
      const hits = new Map<string, TranslationOutcome>();
      for (const { id, text } of tasks) {
        const cachedText = cached.get(id);
        if (cachedText)
          hits.set(JSON.stringify([id, text]), {
            kind: "translated",
            text: cachedText,
          });
      }
      store(hits);
      for (const task of tasks) {
        const key = JSON.stringify([task.id, task.text]);
        if (signal.aborted) break;
        const previous = outcomes.get(key);
        if (
          hits.has(key) ||
          (previous &&
            previous.kind !== "failed" &&
            previous.kind !== "unavailable")
        )
          continue;
        const result = await translation.translate(task, settings.target, {
          signal,
          excludedSources,
        });
        if (result.kind !== "cancelled") store(new Map([[key, result]]));
      }
    })().catch(() => undefined);
    return () => controller.abort();
  }, [viewportKey, translation, settings.target, excludedSources, scope]);

  const displayed = useMemo(() => {
    if (!settings.automatic || !outcomes.size) return items;
    return items.map((item) => {
      if (item.direction !== "incoming") return item;
      const result = outcomes.get(messageKey(item));
      return result?.kind === "translated"
        ? {
            ...item,
            originalText: item.text,
            text: originals.has(item._id) ? item.text : result.text,
          }
        : item;
    });
  }, [items, outcomes, originals, settings.automatic]);

  const missing = useMemo(() => {
    return [
      ...new Set(
        viewport.flatMap(({ id, text }) => {
          const outcome = outcomes.get(JSON.stringify([id, text]));
          return outcome?.kind === "models" ? outcome.languages : [];
        }),
      ),
    ];
  }, [outcomes, viewport]);
  const failed = viewport.some(({ id, text }) => {
    const result = outcomes.get(JSON.stringify([id, text]));
    return result?.kind === "failed" || result?.kind === "unavailable";
  });
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const toggleOriginal = useCallback((id: string) => {
    setOriginals((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const refresh = useCallback(
    (id: string) => translation.refresh(id, settings.target),
    [translation, settings.target],
  );
  return { displayed, missing, failed, retry, toggleOriginal, refresh };
}
