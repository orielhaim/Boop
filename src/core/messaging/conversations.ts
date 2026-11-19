import type { ConversationSummary, MessagingRepository } from "@/db/messaging";
import { messagingMetric } from "./diagnostics";
import type { HistoryLoader } from "./history";

type Snapshot = { rows: ConversationSummary[]; error: boolean };

export function createConversationFeed(
  chat: MessagingRepository,
  history: HistoryLoader,
  readTarget: () => string | undefined,
) {
  let snapshot: Snapshot | undefined;
  let unread = 0;
  let target: string | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  const listeners = new Set<() => void>();
  const badgeListeners = new Set<() => void>();

  function refreshUnread() {
    try {
      const next = chat.unreadCount();
      if (unread === next) return;
      unread = next;
      for (const listener of badgeListeners) listener();
    } catch {
      // Retain the last count when storage is temporarily unavailable.
    }
  }

  function refresh() {
    const started = performance.now();
    try {
      target = readTarget();
      const next = chat.conversations({ translationTarget: target });
      const previous = snapshot?.rows ?? [];
      const previousByKey = new Map(previous.map((row) => [row.peerKey, row]));
      const rows = next.map((row) => {
        const prior = previousByKey.get(row.peerKey);
        if (!prior) return row;
        const values: Record<string, unknown> = prior;
        return Object.entries(row).every(
          ([key, value]) => values[key] === value,
        )
          ? prior
          : row;
      });
      messagingMetric("conversation summaries", {
        ms: performance.now() - started,
        rows: rows.length,
      });
      if (
        snapshot &&
        !snapshot.error &&
        rows.length === previous.length &&
        rows.every((row, index) => row === previous[index])
      )
        return;
      snapshot = { rows, error: false };
    } catch {
      snapshot = { rows: snapshot?.rows ?? [], error: true };
    }
    for (const listener of listeners) listener();
  }

  function invalidate() {
    if (!active || refreshTimer !== undefined) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (active) refresh();
    }, 16);
  }

  function prefetch() {
    const candidates = (snapshot?.rows ?? [])
      .filter((row) => !row.archived && row.lastMessageAt !== null)
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
      .slice(0, 3);
    history.prefetch(candidates.map(({ peerKey }) => peerKey));
  }

  return {
    start() {
      active = true;
      const unsubscribe = chat.subscribe((change) => {
        if (change.unread) refreshUnread();
        if (change.summaries) invalidate();
      });
      refreshUnread();
      refresh();
      prefetch();
      return () => {
        active = false;
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
        unsubscribe();
        history.cancelPrefetch();
      };
    },
    externalChange(tableName: string) {
      if (
        tableName === "contacts" ||
        (tableName === "message_translations" && target)
      ) {
        invalidate();
      } else if (tableName === "settings") {
        try {
          if (readTarget() !== target) invalidate();
        } catch {
          invalidate();
        }
      }
    },
    getSnapshot: () => snapshot,
    getUnreadCount: () => unread,
    refresh,
    prefetch,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeUnread(listener: () => void) {
      badgeListeners.add(listener);
      return () => {
        badgeListeners.delete(listener);
      };
    },
  };
}

export function unreadBadge(count: number) {
  return count === 0 ? undefined : count > 99 ? "99+" : String(count);
}
