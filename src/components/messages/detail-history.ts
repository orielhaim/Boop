import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { createMessagingRepository, MessageCursor } from "@/db/messaging";
import {
  type DetailMessage,
  equalDetailMessage,
  type Participants,
  toDetailMessage,
} from "./detail-adapter";

const pageSize = 50;
type Repository = ReturnType<typeof createMessagingRepository>;
type Scope = { start: MessageCursor | undefined; limit: number };

const latest: Scope = { start: undefined, limit: pageSize * 2 };
const emptyMessages: DetailMessage[] = [];

function readWindow(chat: Repository, peerKey: string, scope: Scope) {
  const page = chat.history(peerKey, {
    limit: Math.min(scope.limit, 200),
    atOrAfter: scope.start,
  });
  const messages = [...page.messages];
  let newer = page.newer;
  while (newer && messages.length < scope.limit) {
    const next = chat.history(peerKey, {
      after: newer,
      limit: Math.min(scope.limit - messages.length, 200),
    });
    messages.push(...next.messages);
    newer = next.newer;
  }
  return { messages, older: page.older, newer };
}

function createProjector(
  chat: Repository,
  peerKey: string,
  participants: Participants,
  unavailable: string,
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
  peerKey: string,
  scope: Scope,
  project: ReturnType<typeof createProjector>,
) {
  let lastRevision: number | undefined;
  let snapshot: Snapshot = {
    items: emptyMessages,
    older: null,
    newer: null,
    error: false,
  };
  return () => {
    const revision = chat.getRevision();
    if (lastRevision === revision) return snapshot;
    lastRevision = revision;
    try {
      const page = readWindow(chat, peerKey, scope);
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
  peerKey: string,
  participants: Participants,
  unavailable: string,
) {
  const [initial] = useState(() => {
    try {
      const page = chat.history(peerKey, { limit: pageSize });
      const firstUnread = page.firstUnreadMessageId;
      const unread =
        firstUnread && !page.messages.some((item) => item.id === firstUnread)
          ? chat.message(peerKey, firstUnread)
          : null;
      return {
        scope: { ...latest, start: unread || page.messages[0] },
        firstUnread,
        detached: Boolean(unread),
      };
    } catch {
      return { scope: latest, firstUnread: null, detached: false };
    }
  });
  const [scope, setScope] = useState(initial.scope);
  const rows = useMemo(
    () => createProjector(chat, peerKey, participants, unavailable),
    [chat, peerKey, participants, unavailable],
  );
  const getSnapshot = useMemo(
    () => createHistorySnapshot(chat, peerKey, scope, rows),
    [chat, peerKey, scope, rows],
  );
  const { items, older, newer, error } = useSyncExternalStore(
    chat.subscribe,
    getSnapshot,
    getSnapshot,
  );

  // A live window reserves one extra page. As it fills, grow the queried range in blocks
  // without dropping rows that Legend List may be using as its visible scroll anchor.
  const extend = useCallback(() => {
    setScope((current) => ({ ...current, limit: current.limit + pageSize }));
  }, []);

  const olderPage = useCallback(() => {
    if (!older) return;
    const page = chat.history(peerKey, { before: older, limit: pageSize });
    const start = page.messages[0];
    if (start) setScope({ start, limit: scope.limit + page.messages.length });
  }, [chat, older, peerKey, scope.limit]);

  const loadAround = useCallback(
    (cursor: MessageCursor) => {
      const page = chat.history(peerKey, {
        atOrBefore: cursor,
        limit: Math.floor(pageSize / 2),
      });
      setScope({ start: page.messages[0] ?? cursor, limit: pageSize });
    },
    [chat, peerKey],
  );

  const loadLatest = useCallback(() => {
    const page = chat.history(peerKey, { limit: pageSize });
    setScope({ ...latest, start: page.messages[0] });
    return page.messages.at(-1)?.id;
  }, [chat, peerKey]);

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
    initiallyDetached: initial.detached,
  };
}
