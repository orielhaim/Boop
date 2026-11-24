import { immer } from "zustand/middleware/immer";
import { createStore } from "zustand/vanilla";

export type AuthFailure =
  | "enrollDevice"
  | "authCancelled"
  | "authLockout"
  | "authUnavailable"
  | "authFailed";

export class AppAuthenticationError extends Error {
  constructor(readonly code: AuthFailure) {
    super(code);
  }
}

export const lockTimeouts = [0, 60_000, 300_000, 1_800_000] as const;
export type LockTimeout = (typeof lockTimeouts)[number];
const lockPreference = "security.appLock";

type LockState = {
  enabled: boolean;
  timeout: LockTimeout;
  locked: boolean;
  hasOpened: boolean;
  active: boolean;
  authenticating: boolean;
  error: AuthFailure | null;
};

export function createAppLock({
  read,
  write,
  startActive,
  authenticate,
  protect,
  now = Date.now,
}: {
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
  startActive: boolean;
  authenticate: (operation: "enable" | "disable" | "unlock") => Promise<void>;
  protect: (enabled: boolean) => Promise<void>;
  now?: () => number;
}) {
  const saved = read(lockPreference);
  const timeout = lockTimeouts.find((value) => String(value) === saved) ?? 0;
  const enabled = saved !== null && saved !== "off";
  const store = createStore<LockState>()(
    immer(() => ({
      enabled,
      timeout,
      locked: enabled,
      hasOpened: !enabled,
      active: startActive,
      authenticating: false,
      error: null,
    })),
  );
  const get = store.getState;
  let awayAt: number | null = startActive ? null : now();
  let protectedWindow = false;
  let autoPrompted = false;
  let returnBy: number | null = null;

  function update(patch: Partial<LockState>) {
    store.setState((state) => {
      Object.assign(state, patch);
      if (state.active && !state.locked) state.hasOpened = true;
    });
  }

  async function change(operation: "enable" | "disable" | "unlock") {
    if (get().authenticating || !get().active) return;
    if (operation === "enable" ? get().enabled : !get().enabled) return;
    if ((operation === "unlock") !== get().locked) return;
    if (operation === "unlock") autoPrompted = true;
    update({ authenticating: true, error: null });
    try {
      await authenticate(operation);
      if (operation !== "disable" && !protectedWindow) {
        await protect(true);
        protectedWindow = true;
      }
      if (operation !== "unlock") {
        const enable = operation === "enable";
        write(lockPreference, enable ? String(get().timeout) : "off");
        update({ enabled: enable });
        if (!enable && protectedWindow) {
          await protect(false);
          protectedWindow = false;
        }
      }
      if (!get().active && get().enabled) returnBy = now() + 2_000;
      autoPrompted = false;
      update({ locked: false });
    } catch (error) {
      if (get().enabled && !get().active && awayAt === null) awayAt = now();
      update({
        error:
          error instanceof AppAuthenticationError ? error.code : "authFailed",
      });
    } finally {
      if (get().active) awayAt = null;
      // The native result can resolve before the foreground event. In either order,
      // content remains covered until active and the successful prompt is not a departure.
      update({ authenticating: false });
    }
  }

  return {
    getState: get,
    subscribe: store.subscribe,
    setActive(active: boolean) {
      if (active === get().active) return;
      let locked = get().locked;
      if (active) {
        if (get().enabled && returnBy !== null) locked ||= now() > returnBy;
        returnBy = null;
        if (get().enabled && awayAt !== null) {
          const elapsed = now() - awayAt;
          locked ||= elapsed < 0 || elapsed >= get().timeout;
        }
        awayAt = null;
      } else if (!get().authenticating) {
        awayAt = now();
        locked ||= get().enabled && get().timeout === 0;
      }
      update({ active, locked });
    },
    setTimeout(timeout: LockTimeout) {
      if (!get().enabled || get().locked || get().authenticating) return;
      write(lockPreference, String(timeout));
      update({ timeout });
    },
    autoUnlock() {
      if (
        autoPrompted ||
        !get().active ||
        !get().locked ||
        get().authenticating
      )
        return;
      void change("unlock");
    },
    async confirmSensitive(confirm: () => Promise<boolean>) {
      if (!get().active || get().locked || get().authenticating) return false;
      update({ authenticating: true });
      let confirmed = false;
      try {
        confirmed = await confirm();
        if (confirmed && get().enabled && !get().active)
          returnBy = now() + 2_000;
        return confirmed;
      } finally {
        if (!confirmed && get().enabled && !get().active) awayAt ??= now();
        update({ authenticating: false });
      }
    },
    change,
  };
}

export type AppLock = ReturnType<typeof createAppLock>;
