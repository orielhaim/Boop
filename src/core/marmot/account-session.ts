import type { MarmotReadiness, MarmotRelays } from "./native";

const sessionRetryDelays = [1000, 4000, 15000];
const permanentFailures = new Set([
  "IdentityMismatch",
  "AccountSignedOut",
  "InvalidSecretKey",
  "SecretNotFound",
  "DuplicateIdentity",
  "MissingDefaultRelays",
]);

function errorCode(error: unknown) {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "NativeFailure";
}

type Configuration = { relays: MarmotRelays; mediaOrigin: string | null };

function sameConfiguration(a: Configuration | null, b: Configuration | null) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createMarmotSession({
  open,
  close,
  beforeClose,
  retryDelays = sessionRetryDelays,
}: {
  open: (
    relays: MarmotRelays,
    mediaOrigin: string | null,
  ) => Promise<MarmotReadiness>;
  close: () => Promise<void>;
  beforeClose: () => Promise<void> | undefined;
  retryDelays?: readonly number[];
}) {
  let desired: Configuration | null = null;
  let active: Configuration | null = null;
  let transition = Promise.resolve();
  let failure: { cause: unknown; code: string } | undefined;
  let revision = 0;
  let retries = 0;
  let retryEnabled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  function changed() {
    revision++;
    for (const listener of listeners) listener();
  }

  function cancelRecovery() {
    clearTimeout(timer);
    timer = undefined;
  }

  function recovering() {
    return (
      failure &&
      desired &&
      retries < retryDelays.length &&
      !permanentFailures.has(failure.code)
    );
  }

  function scheduleRecovery() {
    const delay = retryDelays[retries];
    if (!retryEnabled || timer || !recovering() || delay === undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void reconcile(true);
    }, delay);
  }

  function reconcile(recovery = false) {
    transition = transition.then(async () => {
      if (recovery && (!retryEnabled || !recovering())) return;
      const next = desired;
      if (!failure && sameConfiguration(next, active)) return;
      cancelRecovery();
      try {
        if (active) {
          await beforeClose();
          await close();
          active = null;
        }
        if (next) {
          await open(next.relays, next.mediaOrigin);
          active = next;
        }
        failure = undefined;
        retries = 0;
      } catch (cause) {
        if (recovery) retries++;
        failure = { cause, code: errorCode(cause) };
        if (typeof __DEV__ !== "undefined" && __DEV__)
          console.info("[marmot] account startup", { code: failure.code });
      } finally {
        scheduleRecovery();
        changed();
      }
    });
    return transition;
  }

  return {
    start(
      { general, inbox, discovery }: MarmotRelays,
      mediaOrigin: string | null,
    ) {
      const next = { relays: { general, inbox, discovery }, mediaOrigin };
      if (sameConfiguration(next, desired)) {
        if (!failure || timer || permanentFailures.has(failure.code))
          return transition;
      } else {
        cancelRecovery();
        retries = 0;
      }
      desired = next;
      return reconcile();
    },
    async stop() {
      desired = null;
      cancelRecovery();
      await reconcile();
      if (failure) throw failure.cause;
    },
    setRetryEnabled(enabled: boolean) {
      if (retryEnabled === enabled) return;
      retryEnabled = enabled;
      if (enabled) scheduleRecovery();
      else cancelRecovery();
    },
    reconnected() {
      if (
        !retryEnabled ||
        !desired ||
        !failure ||
        permanentFailures.has(failure.code)
      )
        return;
      cancelRecovery();
      retries = 0;
      void reconcile();
    },
    retry() {
      cancelRecovery();
      retries = 0;
      return reconcile();
    },
    status: () =>
      failure
        ? recovering()
          ? "recovering"
          : "failed"
        : active
          ? "ready"
          : "pending",
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
      if (failure) throw failure.cause;
      if (!active) throw new Error("AccountClosed");
    },
  };
}
