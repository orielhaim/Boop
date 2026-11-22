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
  const { marmotSession, lock } = useLocal();
  const accountRevision = useSyncExternalStore(
    marmotSession.subscribe,
    marmotSession.revision,
  );
  const locked = useSyncExternalStore(lock.subscribe, lock.getState).locked;
  const isFocused = useIsFocused() && enabled;
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{
    open: typeof open;
    window?: MarmotWindow<Snapshot, Direction>;
    error?: string;
  }>();
  const window =
    isFocused && !locked && loaded?.open === open ? loaded.window : undefined;
  const state = useSyncExternalStore(
    window?.subscribe ?? subscribeEmpty,
    window?.getState ?? empty,
  );

  useEffect(() => {
    if (!isFocused || locked) return;
    let cancelled = false;
    let active: MarmotWindow<Snapshot, Direction> | undefined;
    void marmotSession
      .ready()
      .then(open)
      .then((next) => {
        if (cancelled) return next.close();
        active = next;
        setLoaded({ open, window: next });
      })
      .catch((error) => {
        if (!cancelled) {
          const code = marmotErrorCode(error);
          if (__DEV__) console.info("[marmot] window startup", { code });
          setLoaded({ open, error: code });
        }
      });
    return () => {
      cancelled = true;
      void active?.close().catch(() => undefined);
    };
  }, [accountRevision, isFocused, locked, marmotSession, open, retry]);

  return {
    window,
    snapshot: state?.status === "ready" ? state.snapshot : undefined,
    error:
      state?.status === "closed"
        ? state.code
        : loaded?.open === open
          ? loaded.error
          : undefined,
    retry() {
      setLoaded(undefined);
      setRetry((value) => value + 1);
    },
  };
}
