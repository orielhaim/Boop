import type { RelayConfiguration } from "../nostr/config";
import { marmot, type MarmotReadiness } from "./native";

export function createMarmotSession(
  open: (
    relays: RelayConfiguration,
    mediaOrigin: string | null,
  ) => Promise<MarmotReadiness>,
) {
  type Configuration = {
    relays: RelayConfiguration;
    mediaOrigin: string | null;
  };
  let desired: Configuration | null = null;
  let active: Configuration | null = null;
  let transition = Promise.resolve();
  let error: unknown;
  let revision = 0;
  const listeners = new Set<() => void>();

  function changed() {
    revision++;
    for (const listener of listeners) listener();
  }

  function reconcile() {
    transition = transition.then(async () => {
      const next = desired;
      if (!error && JSON.stringify(next) === JSON.stringify(active)) return;
      try {
        if (active) {
          await marmot.closeAccount();
          active = null;
        }
        if (next) {
          await open(next.relays, next.mediaOrigin);
          active = next;
        }
        error = undefined;
      } catch (failure) {
        error = failure;
        if (__DEV__) {
          const code =
            failure && typeof failure === "object" && "code" in failure
              ? failure.code
              : "NativeFailure";
          console.info("[marmot] account startup", { code });
        }
      } finally {
        changed();
      }
    });
    return transition;
  }

  return {
    start(relays: RelayConfiguration, mediaOrigin: string | null) {
      desired = { relays, mediaOrigin };
      return reconcile();
    },
    async stop() {
      desired = null;
      await reconcile();
      if (error) throw error;
    },
    revision: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async ready() {
      // An initial child effect can precede the protected session's connect effect.
      await Promise.resolve();
      await transition;
      if (error) throw error;
      if (!active) throw new Error("AccountClosed");
    },
  };
}
