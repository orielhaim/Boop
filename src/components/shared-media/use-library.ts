import { useIsFocused } from "expo-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState } from "react-native";
import {
  downloadId,
  sourceId,
  type MarmotDownload,
} from "@/core/downloads/types";
import {
  marmot,
  type SharedMediaQuery,
  type SharedMediaRow,
} from "@/core/marmot/native";
import {
  createSharedMediaCollection,
  loadedMediaDate,
  mediaTarget,
} from "@/core/marmot/shared-media";
import { createAttachmentPresentation } from "@/core/marmot/attachment-presentation";
import { speechSource } from "@/core/speech/service";
import { useLocal } from "@/services/local-context";

const history = {
  page: marmot.sharedMediaPage,
  changes: marmot.sharedMediaChanges,
  release: marmot.releaseSharedMediaHandle,
};
const appActive = () => AppState.currentState === "active";

export function mediaDownload(
  row: SharedMediaRow,
  account: string,
): MarmotDownload {
  const { item } = row;
  return {
    kind: "marmot",
    target: mediaTarget(row),
    sender: row.sender,
    expiresAt: row.expiresAt == null ? null : row.expiresAt * 1000,
    name: item.name,
    type: item.type,
    hash: item.plaintextHash,
    total: item.size ?? null,
    voice: speechSource(
      row.group,
      {
        id: row.message,
        sourceId: row.source,
        sender: row.sender,
        sentAt: row.at,
        expiresAt: row.expiresAt,
        deleted: false,
      },
      item,
      account,
    ),
  };
}
function subscribeForeground(notify: () => void) {
  const sub = AppState.addEventListener("change", notify);
  return () => sub.remove();
}

function useCollection(
  query: SharedMediaQuery | undefined,
  authorized: boolean,
  revision: number,
) {
  const [scope, setScope] = useState<{
    collection: ReturnType<typeof createSharedMediaCollection>;
    query: SharedMediaQuery;
    revision: number;
  }>();
  useEffect(() => {
    if (!authorized || !query) return;
    const collection = createSharedMediaCollection(history, query);
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      setScope({ collection, query, revision });
      void collection.next();
    });
    return () => {
      current = false;
      collection.close();
    };
  }, [authorized, query, revision]);
  return authorized && scope?.revision === revision && scope.query === query
    ? scope.collection
    : undefined;
}

function createLibraryMedia(
  downloads: Parameters<typeof createAttachmentPresentation>[1],
) {
  let sources = new Map<
    string,
    { row: SharedMediaRow; source: MarmotDownload }
  >();
  let permitted = false;
  let check: (row: SharedMediaRow) => boolean = () => false;
  const presentation = createAttachmentPresentation(
    marmot,
    downloads,
    (target) => {
      const entry = sources.get(downloadId(target));
      return entry && check(entry.row) ? entry.source : undefined;
    },
    () => permitted && appActive(),
    (target) => sources.get(downloadId(target))?.row.local,
  );
  return {
    presentation,
    update(rows: typeof sources, interactive: boolean, allowed: typeof check) {
      sources = rows;
      permitted = interactive;
      check = allowed;
      presentation.reconcile();
    },
  };
}

export function useLibrary(
  baseQuery: SharedMediaQuery | undefined,
  query: SharedMediaQuery | undefined,
  active: boolean,
) {
  const { chatPreferences, downloads, identity, lock, marmotSession, privacy } =
    useLocal();
  const focused = useIsFocused();
  const foreground = useSyncExternalStore(subscribeForeground, appActive);
  const locked = useSyncExternalStore(lock.subscribe, lock.getState).locked;
  const status = useSyncExternalStore(
    marmotSession.subscribe,
    marmotSession.status,
  );
  const blockListReady = useSyncExternalStore(
    privacy.blocks.subscribe,
    privacy.blocks.ready,
  );
  const revision = useSyncExternalStore(
    marmotSession.subscribe,
    marmotSession.revision,
  );
  const enabled = useSyncExternalStore(
    chatPreferences.subscribe,
    chatPreferences.enabled,
  );
  const authorized =
    baseQuery !== undefined &&
    foreground &&
    !locked &&
    enabled &&
    blockListReady &&
    status === "ready";
  const browse = useCollection(baseQuery, authorized, revision);
  const browsing = useSyncExternalStore(
    browse?.subscribe ?? subscribeNothing,
    browse?.snapshot ?? empty,
  );
  const loadedDate = useMemo(
    () => loadedMediaDate(browsing, query),
    [browsing, query],
  );
  const needsQuery = !!query && !loadedDate?.complete;
  const filtered = useCollection(
    needsQuery ? query : undefined,
    authorized,
    revision,
  );
  const collection = needsQuery ? filtered : browse;
  const queried = useSyncExternalStore(
    filtered?.subscribe ?? subscribeNothing,
    filtered?.snapshot ?? empty,
  );
  const state = loadedDate?.complete
    ? {
        ...browsing,
        rows: loadedDate.rows,
        phase: "ready" as const,
        more: false,
      }
    : needsQuery
      ? loadedDate && queried.observedAt === 0
        ? { ...queried, rows: loadedDate.rows }
        : queried
      : browsing;
  const [visibility, setVisibility] = useState(() => ({ at: Date.now() }));
  const notify = useCallback(() => setVisibility({ at: Date.now() }), []);

  useEffect(() => {
    const unblocks = privacy.subscribe(notify);
    const unhidden = chatPreferences.subscribe(notify);
    return () => {
      unblocks();
      unhidden();
    };
  }, [chatPreferences, notify, privacy]);

  useEffect(() => {
    if (!collection || !focused) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const revalidate = () => {
      void collection.revalidate();
      if (browse && browse !== collection) void browse.revalidate();
    };
    const wake = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        revalidate();
      }, 200);
    };
    const unsubscribe = marmot.subscribeSharedMediaWakeup(wake);
    const interval = setInterval(revalidate, 4_000);
    revalidate();
    return () => {
      unsubscribe();
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [browse, collection, focused]);

  const allowed = useCallback(
    (row: SharedMediaRow, at = Date.now()) => {
      return (
        appActive() &&
        !lock.getState().locked &&
        chatPreferences.enabled() &&
        marmotSession.status() === "ready" &&
        marmotSession.revision() === revision &&
        privacy.blocks.ready() &&
        !privacy.isBlocked(row.sender) &&
        !(row.peer && privacy.isBlocked(row.peer)) &&
        !chatPreferences.hidden(row.group).includes(row.message) &&
        (row.expiresAt == null || row.expiresAt * 1_000 > at)
      );
    },
    [chatPreferences, lock, marmotSession, privacy, revision],
  );

  const scopedRows = useMemo(
    () =>
      state.rows.filter((row) =>
        allowed(row, Math.max(visibility.at, state.observedAt)),
      ),
    [state.rows, state.observedAt, visibility, allowed],
  );
  const browseRows = useMemo(
    () =>
      browsing.rows.filter((row) =>
        allowed(row, Math.max(visibility.at, browsing.observedAt)),
      ),
    [browsing.rows, browsing.observedAt, visibility, allowed],
  );
  useEffect(() => {
    let deadline = Infinity;
    for (const rows of [scopedRows, browseRows])
      for (const row of rows)
        if (row.expiresAt != null)
          deadline = Math.min(deadline, row.expiresAt * 1_000);
    if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(
      notify,
      Math.max(1, Math.min(2_147_483_647, deadline - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [browseRows, notify, scopedRows]);

  const media = useMemo(() => createLibraryMedia(downloads), [downloads]);
  useLayoutEffect(() => {
    const rows = new Map(
      scopedRows.map((row) => {
        const source = mediaDownload(row, identity.publicKey);
        return [sourceId(source), { row, source }];
      }),
    );
    media.update(rows, focused && active && authorized, allowed);
  }, [
    active,
    allowed,
    authorized,
    focused,
    identity.publicKey,
    media,
    scopedRows,
  ]);
  useEffect(() => () => media.presentation.stop(), [media]);

  return {
    state,
    rows: scopedRows,
    browseRows,
    browseMore: browsing.more ? browse?.next : undefined,
    presentation: media.presentation,
    collection,
    interactive: authorized && focused && active,
    unavailable: status === "failed",
    waiting:
      focused &&
      active &&
      foreground &&
      !locked &&
      enabled &&
      !authorized &&
      status !== "failed",
  };
}

const subscribeNothing = () => () => {};
const initial = {
  rows: [],
  more: true,
  phase: "loading",
  observedAt: 0,
} as const;
const empty = () => initial;
