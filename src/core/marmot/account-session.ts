import { sameRelays } from "../nostr/config";
import type { MarmotReadiness } from "./native";

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

export function createMarmotSession({
  open,
  close,
  beforeClose,
}: {
  open: (
    discovery: readonly string[],
    mediaOrigin: string | null,
  ) => Promise<MarmotReadiness>;
  close: (pauseMessaging: boolean) => Promise<void>;
  beforeClose: () => Promise<void> | undefined;
}) {
  let desired: Configuration | null = null;
  let active: Configuration | null = null;
  let state: State = { status: "pending" };
  let transition = Promise.resolve();
  let revision = 0;
  let transitioning = false;
  const listeners = new Set<() => void>();

  function publish(next: State) {
    state = next;
    revision++;
    for (const listener of listeners) listener();
  }

  function reconcile(pauseMessaging = false) {
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
          transitioning = false;
          publish({ status: active ? "ready" : "pending" });
        }
      } catch (cause) {
        if (next === desired) {
          transitioning = false;
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
      desired = next;
      return reconcile();
    },
    async stop(pauseMessaging = false) {
      if (desired || active || pauseMessaging) {
        desired = null;
        await reconcile(pauseMessaging);
      } else await transition;
      if (state.status === "failed") throw state.cause;
    },
    retry() {
      if (desired && state.status === "failed") return reconcile();
      return transition;
    },
    reconnected() {
      if (!desired || state.status !== "failed") return;
      const { cause } = state;
      if (
        typeof cause === "object" &&
        cause &&
        "code" in cause &&
        typeof cause.code === "string" &&
        terminal.has(cause.code)
      )
        return;
      void reconcile();
    },
    status: () => state.status,
    transitioning: () => transitioning,
    revision: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async ready() {
      await Promise.resolve();
      await transition;
      if (state.status === "failed") throw state.cause;
      if (state.status !== "ready") throw new Error("AccountClosed");
    },
  };
}
