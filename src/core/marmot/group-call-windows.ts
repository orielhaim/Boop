import type { marmot } from "./native";

type Open = typeof marmot.openGroupCall;
type Window = Awaited<ReturnType<Open>>;
type Entry = {
  revision: number;
  opening: Promise<Window>;
  window?: Window;
  readers: number;
};

export function createGroupCallWindows(open: Open, revision: () => number) {
  const entries = new Map<string, Entry>();

  function current(group: string) {
    const entry = entries.get(group);
    if (
      entry?.revision === revision() &&
      entry.window?.getState().status !== "closed"
    )
      return entry;
  }

  return {
    peek(group: string) {
      return current(group)?.window;
    },
    async acquire(group: string): Promise<Window> {
      let entry = current(group);
      if (!entry) {
        entry = { revision: revision(), opening: open(group), readers: 0 };
        entries.set(group, entry);
      }
      const shared = entry;
      shared.readers++;
      let released = false;
      function release() {
        if (released) return Promise.resolve();
        released = true;
        if (--shared.readers > 0) return Promise.resolve();
        if (entries.get(group) === shared) entries.delete(group);
        return shared.window?.close() ?? Promise.resolve();
      }

      try {
        const window = await shared.opening;
        shared.window = window;
        return { ...window, close: release };
      } catch (error) {
        await release();
        throw error;
      }
    },
  };
}
