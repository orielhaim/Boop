import type { MarmotWindow } from "@/core/marmot/native";

type AuthorityWindow = Pick<
  MarmotWindow<{ authorityReady: boolean }, never>,
  "getState" | "subscribe"
>;

export function waitForMediaAuthority(
  window: AuthorityWindow,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    function finish(error?: unknown) {
      clearTimeout(timeout);
      unsubscribe();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    function abort() {
      finish(signal.reason ?? new Error("AudioUnavailable"));
    }
    function check() {
      const state = window.getState();
      if (signal.aborted) abort();
      else if (state.status === "closed") finish(new Error("AudioUnavailable"));
      else if (state.snapshot.authorityReady) finish();
    }
    const timeout = setTimeout(
      () => finish(new Error("AudioUnavailable")),
      5_000,
    );
    const unsubscribe = window.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}
