import { useIsFocused } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { MarmotWindow } from "@/core/marmot/native";
import { useLocal } from "@/services/local-context";

const unsubscribe = () => {};
const subscribeEmpty = () => unsubscribe;
const empty = () => null;

export function marmotErrorCode(error: unknown) {
  if (
    typeof error === "object" &&
    error &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return "NativeFailure";
}

export function useMarmotWindow<Snapshot, Direction>(
  open: () => Promise<MarmotWindow<Snapshot, Direction>>,
  enabled = true,
) {
  const focused = useIsFocused();
  return useAccountMarmotWindow(open, enabled && focused);
}

export function useAccountMarmotWindow<Snapshot, Direction>(
  open: () => Promise<MarmotWindow<Snapshot, Direction>>,
  enabled: boolean,
) {
  const { marmotSession, lock } = useLocal();
  const accountRevision = useSyncExternalStore(
    marmotSession.subscribe,
    marmotSession.revision,
  );
  const accountStatus = useSyncExternalStore(
    marmotSession.subscribe,
    marmotSession.status,
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
  const window = current?.window;
  const state = useSyncExternalStore(
    window?.subscribe ?? subscribeEmpty,
    window?.getState ?? empty,
  );

  useEffect(() => {
    if (
      !enabled ||
      locked ||
      accountStatus === "pending" ||
      accountStatus === "recovering"
    )
      return;
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
  }, [
    accountRevision,
    accountStatus,
    enabled,
    locked,
    lock,
    marmotSession,
    open,
    retry,
  ]);

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
