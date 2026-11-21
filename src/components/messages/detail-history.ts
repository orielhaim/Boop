import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  type HistoryLoader,
  recentPageSize as pageSize,
} from "@/core/messaging/history";
import {
  type MessageCursor,
  type MessagingRepository,
  maximumHistoryWindow,
} from "@/db/messaging";
import {
  type DetailMessage,
  equalDetailMessage,
  type Participants,
  toDetailMessage,
} from "./detail-adapter";

type Repository = MessagingRepository;
type Scope = { start: MessageCursor | undefined; limit: number };
type Page = ReturnType<Repository["history"]>;

const latest: Scope = { start: undefined, limit: pageSize * 2 };
const emptyMessages: DetailMessage[] = [];

function readWindow(
  history: HistoryLoader,
  peerKey: string,
  scope: Scope,
): Page {
  if (!scope.start) return history.recent(peerKey).page;
  return history.read(peerKey, {
    limit: scope.limit,
    atOrAfter: scope.start,
  });
}

function createProjector(
  chat: Repository,
  peerKey: string,
  participants: Participants,
  unavailable: string,
  lockedLabel: string,
  voiceLabel: string,
) {
  let previous = emptyMessages;
  return (messages: ReturnType<Repository["history"]>["messages"]) => {
    const references = chat.refs(
      peerKey,
      messages.flatMap((row) => (row.replyTo ? [row.replyTo] : [])),
    );
    const previousById = new Map(previous.map((row) => [row._id, row]));
    const next = messages.map((row) => {
      const item = toDetailMessage(
        row,
        row.replyTo ? references.get(row.replyTo) : undefined,
        participants,
        unavailable,
        lockedLabel,
        voiceLabel,
      );
      const prior = previousById.get(item._id);
      return prior && equalDetailMessage(prior, item) ? prior : item;
    });
    if (
      next.length !== previous.length ||
      next.some((item, idx) => item !== previous[idx])
    )
      previous = next;
    return previous;
  };
}

type Snapshot = {
  items: DetailMessage[];
  older: MessageCursor | null;
  newer: MessageCursor | null;
  error: boolean;
};

// Cache one immutable result per repository revision, as useSyncExternalStore requires.
function createHistorySnapshot(
  chat: Repository,
  history: HistoryLoader,
  peerKey: string,
  scope: Scope,
  project: ReturnType<typeof createProjector>,
  initial: { scope: Scope; page?: Page; revision?: number },
) {
  let lastRevision: number | undefined;
  let readScope = scope;
  let snapshot: Snapshot = {
    items: emptyMessages,
    older: null,
    newer: null,
    error: false,
  };
  return () => {
    const revision = chat.historyRevision(peerKey);
    if (lastRevision === revision) return snapshot;
    lastRevision = revision;
    try {
      const page =
        initial.scope === scope && initial.revision === revision && initial.page
          ? initial.page
          : readWindow(history, peerKey, readScope);
      if (!readScope.start && page.messages[0])
        readScope = { ...scope, start: page.messages[0] };
      snapshot = {
        items: project(page.messages),
        older: page.older,
        newer: page.newer,
        error: false,
      };
    } catch {
      snapshot = { ...snapshot, error: true };
    }
    return snapshot;
  };
}

export function useDetailHistory(
  chat: Repository,
  history: HistoryLoader,
  peerKey: string,
  participants: Participants,
  unavailable: string,
  lockedLabel: string,
  voiceLabel: string,
) {
  const [initial] = useState(() => {
    try {
      const { page: recent, unread } = history.recent(peerKey);
      const saved = !unread ? history.position(peerKey) : undefined;
      const restored = saved
        ? chat.refs(peerKey, [saved.id]).get(saved.id)
        : undefined;
      const anchor = unread ?? restored;
      const outsideRecent =
        anchor && !recent.messages.some((item) => item.id === anchor.id);
      let page = recent;
      if (outsideRecent) {
        const prefix = restored
          ? history.read(peerKey, { atOrBefore: restored, limit: pageSize / 2 })
          : null;
        page = history.read(peerKey, {
          atOrAfter: prefix?.messages[0] ?? anchor,
          limit: pageSize,
        });
      }
      return {
        scope: { ...latest, start: page.messages[0] },
        page,
        revision: chat.historyRevision(peerKey),
        firstUnread: unread?.id ?? null,
        restored: restored?.id,
        detached: Boolean(outsideRecent),
      };
    } catch {
      return {
        scope: latest,
        firstUnread: null,
        restored: undefined,
        detached: false,
      };
    }
  });
  const [scope, setScope] = useState(initial.scope);
  const rows = useMemo(
    () =>
      createProjector(
        chat,
        peerKey,
        participants,
        unavailable,
        lockedLabel,
        voiceLabel,
      ),
    [chat, peerKey, participants, unavailable, lockedLabel, voiceLabel],
  );
  const getSnapshot = useMemo(
    () => createHistorySnapshot(chat, history, peerKey, scope, rows, initial),
    [chat, history, peerKey, scope, rows, initial],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = chat.subscribe(({ history }) => {
        if (history === "all" || history?.includes(peerKey)) {
          timer ??= setTimeout(() => {
            timer = undefined;
            listener();
          }, 16);
        }
      });
      return () => {
        clearTimeout(timer);
        stop();
      };
    },
    [chat, peerKey],
  );
  const { items, older, newer, error } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const extend = useCallback(() => {
    if (scope.limit < maximumHistoryWindow) {
      const first = items[0];
      setScope({
        start:
          scope.start ??
          (first ? { id: first._id, sentAt: first.createdAt } : undefined),
        limit: Math.min(scope.limit + pageSize, maximumHistoryWindow),
      });
    } else {
      const anchor = items[pageSize];
      if (anchor)
        setScope({
          start: { id: anchor._id, sentAt: anchor.createdAt },
          limit: maximumHistoryWindow,
        });
    }
  }, [scope, items]);

  const olderPage = useCallback(() => {
    if (!older) return;
    const page = history.read(peerKey, { before: older, limit: pageSize });
    const start = page.messages[0];
    if (start)
      setScope({
        start,
        limit: Math.min(
          maximumHistoryWindow,
          scope.limit + page.messages.length,
        ),
      });
  }, [history, older, peerKey, scope.limit]);

  const loadAround = useCallback(
    (cursor: MessageCursor) => {
      const page = history.read(peerKey, {
        atOrBefore: cursor,
        limit: Math.floor(pageSize / 2),
      });
      setScope({ start: page.messages[0] ?? cursor, limit: pageSize });
    },
    [history, peerKey],
  );

  const loadLatest = useCallback(() => {
    const { page } = history.recent(peerKey);
    setScope({ ...latest, start: page.messages[0] });
    return page.messages.at(-1)?.id;
  }, [history, peerKey]);

  return {
    items,
    older,
    newer,
    error,
    extend,
    olderPage,
    loadAround,
    loadLatest,
    retry: () => setScope((current) => ({ ...current })),
    firstUnreadMessageId: initial.firstUnread,
    restoredMessageId: initial.restored,
    initiallyDetached: initial.detached,
  };
}
