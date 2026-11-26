import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { marmotErrorCode } from "@/core/marmot/errors";
import type { MarmotWindow } from "@/core/marmot/native";
import { useChatsEnabled, useLocal } from "@/services/local-context";

const unsubscribe = () => {};
const subscribeEmpty = () => unsubscribe;
const empty = () => null;

export function useConversationWindow(
  group: string,
  target: string | undefined,
  active: boolean,
) {
  const { conversations, marmotSession } = useLocal();
  const ready = useSyncExternalStore(
    conversations.subscribe,
    conversations.ready,
  );
  const revision = useSyncExternalStore(
    conversations.subscribe,
    conversations.revision,
  );
  const view = useSyncExternalStore(conversations.subscribe, () =>
    conversations.get(group, target),
  );
  const status = useSyncExternalStore(
    marmotSession.subscribe,
    marmotSession.status,
  );
  useEffect(() => {
    if (active && ready) return conversations.acquire(group, target);
  }, [active, conversations, group, ready, revision, target]);

  return {
    snapshot: view?.snapshot,
    window: view?.window,
    error: view?.error ?? (status === "failed" ? "AccountClosed" : undefined),
    retry() {
      if (status === "failed") void marmotSession.retry();
      else conversations.retry(group, target);
    },
  };
}

export function useMarmotWindow<Snapshot, Direction>(
  open: () => Promise<MarmotWindow<Snapshot, Direction>>,
  enabled = true,
) {
  const focused = useIsFocused();
  return useAccountMarmotWindow(open, enabled && focused);
}

export function useGroupCallWindow(group: string, enabled: boolean) {
  const { groupCallWindows, lock } = useLocal();
  const chatsEnabled = useChatsEnabled();
  const accountActive = useSyncExternalStore(
    lock.subscribe,
    () => lock.getState().active,
  );
  const open = useCallback(
    () => groupCallWindows.acquire(group),
    [group, groupCallWindows],
  );
  return useAccountMarmotWindow(
    open,
    enabled && chatsEnabled && accountActive,
    () => groupCallWindows.peek(group),
  );
}

export function useAccountMarmotWindow<Snapshot, Direction>(
  open: () => Promise<MarmotWindow<Snapshot, Direction>>,
  enabled: boolean,
  peek?: () => MarmotWindow<Snapshot, Direction> | undefined,
) {
  const { marmotSession, lock } = useLocal();
  const accountRevision = useSyncExternalStore(
    marmotSession.subscribe,
    marmotSession.revision,
  );
  const locked = useSyncExternalStore(lock.subscribe, lock.getState).locked;
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{
    open: typeof open;
    session: typeof marmotSession;
    accountRevision: number;
    window?: MarmotWindow<Snapshot, Direction>;
    error?: string;
  }>();
  const current =
    enabled &&
    !locked &&
    loaded?.open === open &&
    loaded.session === marmotSession &&
    loaded.accountRevision === accountRevision
      ? loaded
      : undefined;
  const window = current?.window ?? (enabled && !locked ? peek?.() : undefined);
  const state = useSyncExternalStore(
    window?.subscribe ?? subscribeEmpty,
    window?.getState ?? empty,
  );

  useEffect(() => {
    if (!enabled || locked || marmotSession.status() === "pending") return;
    let cancelled = false;
    let active: MarmotWindow<Snapshot, Direction> | undefined;
    const isCurrent = () =>
      !cancelled &&
      !lock.getState().locked &&
      marmotSession.revision() === accountRevision;
    void marmotSession
      .ready()
      .then(() => (isCurrent() ? open() : undefined))
      .then((next) => {
        if (!next) return;
        if (!isCurrent()) return next.close();
        active = next;
        setLoaded({
          open,
          session: marmotSession,
          accountRevision,
          window: next,
        });
      })
      .catch((error) => {
        if (isCurrent()) {
          const code = marmotErrorCode(error);
          if (__DEV__) console.info("[marmot] window startup", { code });
          setLoaded({
            open,
            session: marmotSession,
            accountRevision,
            error: code,
          });
        }
      });
    return () => {
      cancelled = true;
      if (active) {
        void active.close().catch(() => undefined);
        queueMicrotask(() => {
          setLoaded((previous) =>
            previous?.window === active ? undefined : previous,
          );
        });
      }
    };
  }, [accountRevision, enabled, locked, lock, marmotSession, open, retry]);

  return {
    window,
    snapshot: state?.status === "ready" ? state.snapshot : undefined,
    error: state?.status === "closed" ? state.code : current?.error,
    retry() {
      if (marmotSession.status() === "failed") {
        void marmotSession.retry();
        return;
      }
      setLoaded(undefined);
      setRetry((value) => value + 1);
    },
  };
}
