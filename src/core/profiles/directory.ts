import { publicMediaUrl } from "../media/url";
import type { MarmotPublicProfile } from "../marmot/native";

type Reader = {
  read(keys: string[]): Promise<MarmotPublicProfile[]>;
  refresh(key: string, relays: readonly string[]): Promise<void>;
};
const visibleLimit = 32;
const refreshInterval = 5 * 60_000;

function present(profile: MarmotPublicProfile) {
  return {
    ...profile,
    handle: profile.name,
    name: profile.displayName || profile.name,
    picture: profile.picture
      ? publicMediaUrl(profile.picture)?.href
      : undefined,
    banner: profile.banner ? publicMediaUrl(profile.banner)?.href : undefined,
    website: profile.website
      ? publicMediaUrl(profile.website)?.href
      : undefined,
  };
}

export function createProfileDirectory(
  reader: Reader,
  eligible: () => boolean,
  blocked: (key: string) => boolean,
  relays: () => readonly string[],
) {
  const profiles = new Map<string, ReturnType<typeof present>>();
  const listeners = new Map<string, Set<() => void>>();
  const visible = new Map<string, number>();
  const pending = new Set<string>();
  const refreshed = new Map<string, number>();
  let generation = 0;
  let active = false;
  let scheduled = false;
  let reading = false;
  let refreshing = false;

  function receive(row: MarmotPublicProfile) {
    const value = present(row);
    if (JSON.stringify(profiles.get(row.key)) === JSON.stringify(value)) return;
    profiles.delete(row.key);
    profiles.set(row.key, value);
    for (const key of profiles.keys()) {
      if (profiles.size <= 256) break;
      if (!listeners.has(key) && !visible.has(key)) profiles.delete(key);
    }
    for (const listener of listeners.get(row.key) ?? []) listener();
  }

  function valid(epoch: number) {
    return active && epoch === generation && eligible();
  }

  async function load(keys: string[], epoch: number) {
    if (!keys.length || !valid(epoch)) return;
    const rows = await reader.read(keys).catch(() => []);
    if (valid(epoch)) rows.forEach(receive);
  }

  function schedule() {
    if (!active || scheduled || !eligible()) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const epoch = generation;
      if (!valid(epoch)) return;

      if (pending.size && !reading) {
        const keys = [...pending].slice(0, 100);
        for (const key of keys) pending.delete(key);
        reading = true;
        void load(keys, epoch).finally(() => {
          reading = false;
          if (epoch !== generation && active)
            keys.forEach((key) => pending.add(key));
          schedule();
        });
      }

      const routes = relays();
      if (refreshing || !routes.length) return;
      const now = Date.now();
      const keys = [...visible.keys()]
        .reverse()
        .slice(0, visibleLimit)
        .filter((key) => !blocked(key) && (refreshed.get(key) ?? 0) <= now)
        .slice(0, 3);
      if (!keys.length) return;
      refreshing = true;
      for (const key of keys) {
        refreshed.set(key, now + refreshInterval);
        if (refreshed.size > 256) {
          const oldest = refreshed.keys().next().value;
          if (oldest) refreshed.delete(oldest);
        }
      }
      void Promise.allSettled(
        keys.map((key) => reader.refresh(key, routes)),
      ).finally(() => {
        refreshing = false;
        for (const key of keys) if (visible.has(key)) pending.add(key);
        schedule();
      });
    });
  }

  return {
    profile: (key: string) => profiles.get(key),
    presentSearch(rows: MarmotPublicProfile[]) {
      if (!valid(generation)) return;
      for (const row of rows) if (!profiles.has(row.key)) receive(row);
    },
    reload(key: string) {
      generation++;
      pending.add(key);
      schedule();
    },
    setActive(next: boolean) {
      if (next === active) return;
      active = next;
      generation++;
      if (next) {
        for (const key of listeners.keys()) pending.add(key);
        schedule();
      }
    },
    routesChanged() {
      refreshed.clear();
      schedule();
    },
    read(keys: string[]) {
      for (const key of keys) if (/^[a-f0-9]{64}$/u.test(key)) pending.add(key);
      schedule();
    },
    subscribe(key: string, listener: () => void) {
      if (!/^[a-f0-9]{64}$/u.test(key)) return () => {};
      const callbacks = listeners.get(key) ?? new Set();
      listeners.set(key, callbacks);
      callbacks.add(listener);
      pending.add(key);
      schedule();
      return () => {
        callbacks.delete(listener);
        if (!callbacks.size) listeners.delete(key);
      };
    },
    watch(key: string) {
      if (!/^[a-f0-9]{64}$/u.test(key)) return () => {};
      visible.set(key, (visible.get(key) ?? 0) + 1);
      pending.add(key);
      schedule();
      return () => {
        const count = visible.get(key) ?? 0;
        if (count <= 1) visible.delete(key);
        else visible.set(key, count - 1);
      };
    },
    async refresh(key: string, hints: readonly string[], signal: AbortSignal) {
      const epoch = generation;
      if (!valid(epoch) || blocked(key) || signal.aborted) return;
      await reader.refresh(key, hints);
      if (!signal.aborted && !blocked(key)) await load([key], epoch);
    },
  };
}
