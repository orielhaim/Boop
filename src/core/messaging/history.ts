import type {
  HistoryOptions,
  MessageCursor,
  MessagingRepository,
} from "@/db/messaging";
import { messagingMetric } from "./diagnostics";

export const recentPageSize = 50;
const warmLimit = 5;
const prefetchLimit = 3;
const prefetchDelay = 120;
type Page = ReturnType<MessagingRepository["history"]>;
type Recent = { page: Page; unread: MessageCursor | undefined };

export function createHistoryLoader(chat: MessagingRepository) {
  const warm = new Map<string, { revision: number; data: Recent }>();
  const pending = new Map<string, Promise<Recent>>();
  const visited = new Map<string, MessageCursor | null>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function recent(peerKey: string): Recent {
    if (disposed) throw new Error("Messaging session has ended");
    const revision = chat.historyRevision(peerKey);
    const cached = warm.get(peerKey);
    const started = performance.now();
    const entry =
      cached?.revision === revision
        ? cached
        : {
            revision,
            data: {
              page: chat.history(peerKey, { limit: recentPageSize }),
              unread: chat.firstUnread(peerKey),
            },
          };
    warm.delete(peerKey);
    warm.set(peerKey, entry);
    if (warm.size > warmLimit) {
      const oldest = warm.keys().next().value;
      if (oldest !== undefined) warm.delete(oldest);
    }
    messagingMetric("recent page", {
      ms: performance.now() - started,
      hit: entry === cached,
      rows: entry.data.page.messages.length,
      cachedPages: warm.size,
    });
    return entry.data;
  }

  function loadRecent(peerKey: string) {
    const existing = pending.get(peerKey);
    if (existing) {
      messagingMetric("shared page request", {});
      return existing;
    }
    // The synchronous foreground reader can satisfy queued work before it starts.
    const load = Promise.resolve()
      .then(() => recent(peerKey))
      .finally(() => pending.delete(peerKey));
    pending.set(peerKey, load);
    return load;
  }

  function cancelPrefetch() {
    clearTimeout(timer);
    timer = undefined;
  }

  function prefetch(keys: readonly string[]) {
    if (disposed) return;
    cancelPrefetch();
    const queue = [
      ...new Set([...Array.from(visited.keys()).reverse(), ...keys]),
    ]
      .filter((key) => warm.get(key)?.revision !== chat.historyRevision(key))
      .slice(0, prefetchLimit);
    function schedule() {
      if (!queue.length) return;
      timer = setTimeout(() => {
        const peerKey = queue.shift();
        if (peerKey === undefined) return;
        void loadRecent(peerKey).catch(() => undefined);
        schedule();
      }, prefetchDelay);
    }
    schedule();
  }

  const unsubscribe = chat.subscribe(({ history }) => {
    if (history === "all") warm.clear();
    else for (const key of history ?? []) warm.delete(key);
  });

  return {
    recent,
    loadRecent,
    read(peerKey: string, options: HistoryOptions) {
      if (disposed) throw new Error("Messaging session has ended");
      return chat.history(peerKey, options);
    },
    prefetch,
    cancelPrefetch,
    position: (peerKey: string) => visited.get(peerKey),
    remember(peerKey: string, position: MessageCursor | null) {
      visited.delete(peerKey);
      visited.set(peerKey, position);
      if (visited.size > warmLimit) {
        const oldest = visited.keys().next().value;
        if (oldest !== undefined) visited.delete(oldest);
      }
    },
    dispose() {
      disposed = true;
      cancelPrefetch();
      unsubscribe();
      pending.clear();
      warm.clear();
      visited.clear();
    },
  };
}

export type HistoryLoader = ReturnType<typeof createHistoryLoader>;
