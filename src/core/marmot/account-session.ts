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
  close: () => Promise<void>;
  beforeClose: () => Promise<void> | undefined;
}) {
  let desired: Configuration | null = null;
  let active: Configuration | null = null;
  let state: State = { status: "pending" };
  let transition = Promise.resolve();
  let revision = 0;
  const listeners = new Set<() => void>();

  function publish(next: State) {
    state = next;
    revision++;
    for (const listener of listeners) listener();
  }

  function reconcile() {
    const next = desired;
    transition = transition.then(async () => {
      if (next !== desired) return;
      try {
        if (active && active !== next) {
          await beforeClose();
          await close();
          active = null;
        }
        if (next !== desired) return;
        if (next && active !== next) {
          await open(next.discovery, next.mediaOrigin);
          active = next;
        }
        if (next === desired) publish({ status: active ? "ready" : "pending" });
      } catch (cause) {
        if (next === desired) publish({ status: "failed", cause });
      }
    });
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
    async stop() {
      if (desired || active) {
        desired = null;
        await reconcile();
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
