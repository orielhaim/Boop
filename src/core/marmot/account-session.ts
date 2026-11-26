import { createStore } from "zustand/vanilla";
import { marmotErrorCode } from "./errors";
import { sameRelays } from "../nostr/config";
import type { MarmotReadiness } from "./native";
import { createRecovery } from "./recovery";

type Configuration = {
  discovery: readonly string[];
  mediaOrigin: string | null;
};
type State =
  { status: "pending" | "ready" } | { status: "failed"; cause: unknown };
const terminal = new Set([
  "IdentityMismatch",
  "AccountSignedOut",
  "SecretNotFound",
]);

export function createMarmotCatchUp({
  allowed,
  wake,
  catchUp,
}: {
  allowed: () => boolean;
  wake: () => Promise<void>;
  catchUp: () => Promise<void>;
}) {
  let pending = false;
  let wakePending = false;
  let running = false;
  const recovery = createRecovery(run);

  function run() {
    if (running || !pending || !allowed()) return;
    running = true;
    pending = false;
    const shouldWake = wakePending;
    wakePending = false;
    void (async () => {
      if (shouldWake) await wake().catch(() => undefined);
      if (!allowed()) {
        pending = true;
        return;
      }
      await catchUp();
      recovery.reset();
    })().then(
      () => {
        running = false;
        run();
      },
      () => {
        running = false;
        pending = true;
        if (allowed()) recovery.schedule();
      },
    );
  }

  return {
    request(shouldWake = false) {
      pending = true;
      wakePending ||= shouldWake;
      recovery.reset();
      run();
    },
    pause: recovery.cancel,
  };
}

export function createMarmotSession({
  open,
  close,
  beforeClose,
  canRetry = () => true,
}: {
  open: (
    discovery: readonly string[],
    mediaOrigin: string | null,
  ) => Promise<MarmotReadiness>;
  close: (pauseMessaging: boolean) => Promise<void>;
  beforeClose: () => Promise<void> | undefined;
  canRetry?: () => boolean;
}) {
  let desired: Configuration | null = null;
  let active: Configuration | null = null;
  const { getState, setState, subscribe } = createStore<{
    state: State;
    revision: number;
  }>(() => ({
    state: { status: "pending" },
    revision: 0,
  }));
  let transition = Promise.resolve();
  let transitioning = false;
  const recovery = createRecovery(retryTransient);

  function retryTransient() {
    const { state } = getState();
    if (
      desired &&
      canRetry() &&
      state.status === "failed" &&
      !terminal.has(marmotErrorCode(state.cause))
    )
      void reconcile();
  }

  function publish(state: State) {
    setState({ state, revision: getState().revision + 1 });
  }

  function reconcile(pauseMessaging = false) {
    recovery.cancel();
    const next = desired;
    transition = transition.then(async () => {
      if (next !== desired) return;
      try {
        if ((active && active !== next) || pauseMessaging) {
          if (active) await beforeClose();
          await close(pauseMessaging);
          active = null;
        }
        if (next !== desired) return;
        if (next && active !== next) {
          await open(next.discovery, next.mediaOrigin);
          active = next;
        }
        if (next === desired) {
          recovery.reset();
          transitioning = false;
          publish({ status: active ? "ready" : "pending" });
        }
      } catch (cause) {
        if (next === desired) {
          transitioning = false;
          if (next && !terminal.has(marmotErrorCode(cause)) && canRetry())
            recovery.schedule();
          publish({ status: "failed", cause });
        }
      }
    });
    transitioning = true;
    publish({ status: "pending" });
    return transition;
  }

  return {
    start(discovery: readonly string[], mediaOrigin: string | null) {
      if (
        desired?.mediaOrigin === mediaOrigin &&
        sameRelays(discovery, desired.discovery)
      )
        return transition;
      const next = { discovery, mediaOrigin };
      recovery.reset();
      desired = next;
      return reconcile();
    },
    async stop(pauseMessaging = false) {
      recovery.reset();
      if (desired || active || pauseMessaging) {
        desired = null;
        await reconcile(pauseMessaging);
      } else await transition;
      const { state } = getState();
      if (state.status === "failed") throw state.cause;
    },
    retry() {
      if (desired && getState().state.status === "failed") return reconcile();
      return transition;
    },
    reconnected: retryTransient,
    status: () => getState().state.status,
    transitioning: () => transitioning,
    revision: () => getState().revision,
    subscribe,
    async ready() {
      await Promise.resolve();
      await transition;
      const { state } = getState();
      if (state.status === "failed") throw state.cause;
      if (state.status !== "ready") throw new Error("AccountClosed");
    },
  };
}
