import type { RelayConfiguration } from "../nostr/config";
import { marmot, type MarmotReadiness } from "./native";

export function createMarmotSession(
  open: (relays: RelayConfiguration) => Promise<MarmotReadiness>,
) {
  let desired: RelayConfiguration | null = null;
  let active: RelayConfiguration | null = null;
  let transition = Promise.resolve();
  let error: unknown;

  function reconcile() {
    transition = transition.then(async () => {
      const next = desired;
      if (JSON.stringify(next) === JSON.stringify(active)) return;
      try {
        if (active) {
          await marmot.closeAccount();
          active = null;
        }
        if (next) {
          await open(next);
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
      }
    });
    return transition;
  }

  return {
    start(relays: RelayConfiguration) {
      desired = relays;
      return reconcile();
    },
    stop() {
      desired = null;
      return reconcile();
    },
    async ready() {
      // An initial child effect can precede the protected session's connect effect.
      await Promise.resolve();
      await reconcile();
      if (error) throw error;
      if (!active) throw new Error("AccountClosed");
    },
  };
}
