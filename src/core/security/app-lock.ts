export const lockTimeouts = [0, 60_000, 300_000, 1_800_000] as const;
export type LockTimeout = (typeof lockTimeouts)[number];
const lockPreference = "security.appLock";

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
  let state = {
    enabled,
    timeout,
    locked: enabled,
    hasOpened: !enabled,
    active: startActive,
    authenticating: false,
    error: "",
  };
  let awayAt: number | null = startActive ? null : now();
  const listeners = new Set<() => void>();
  let protectedWindow = false;
  let autoPrompted = false;
  let returnBy: number | null = null;

  function update(patch: Partial<typeof state>) {
    state = { ...state, ...patch };
    if (state.active && !state.locked) state.hasOpened = true;
    for (const listener of listeners) listener();
  }

  async function change(operation: "enable" | "disable" | "unlock") {
    if (state.authenticating || !state.active) return;
    if (operation === "enable" ? state.enabled : !state.enabled) return;
    if ((operation === "unlock") !== state.locked) return;
    if (operation === "unlock") autoPrompted = true;
    update({ authenticating: true, error: "" });
    try {
      await authenticate(operation);
      if (operation !== "disable" && !protectedWindow) {
        await protect(true);
        protectedWindow = true;
      }
      if (operation !== "unlock") {
        const enable = operation === "enable";
        write(lockPreference, enable ? String(state.timeout) : "off");
        update({ enabled: enable });
        if (!enable && protectedWindow) {
          await protect(false);
          protectedWindow = false;
        }
      }
      if (!state.active && state.enabled) returnBy = now() + 2_000;
      autoPrompted = false;
      update({ locked: false });
    } catch (error) {
      if (state.enabled && !state.active && awayAt === null) awayAt = now();
      update({
        error:
          error instanceof Error
            ? error.message
            : "Authentication could not be completed.",
      });
    } finally {
      if (state.active) awayAt = null;
      // The native result can resolve before the foreground event. In either order,
      // content remains covered until active and the successful prompt is not a departure.
      update({ authenticating: false });
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setActive(active: boolean) {
      if (active === state.active) return;
      let locked = state.locked;
      if (active) {
        if (state.enabled && returnBy !== null) locked ||= now() > returnBy;
        returnBy = null;
        if (state.enabled && awayAt !== null) {
          const elapsed = now() - awayAt;
          locked ||= elapsed < 0 || elapsed >= state.timeout;
        }
        awayAt = null;
      } else if (!state.authenticating) {
        awayAt = now();
        locked ||= state.enabled && state.timeout === 0;
      }
      update({ active, locked });
    },
    setTimeout(timeout: LockTimeout) {
      if (!state.enabled || state.locked || state.authenticating) return;
      write(lockPreference, String(timeout));
      update({ timeout });
    },
    autoUnlock() {
      if (
        autoPrompted ||
        !state.active ||
        !state.locked ||
        state.authenticating
      )
        return;
      void change("unlock");
    },
    change,
  };
}

export type AppLock = ReturnType<typeof createAppLock>;
