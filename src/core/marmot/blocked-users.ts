import { createStore } from "zustand/vanilla";
import { parsePublicKey } from "../identity/keys";

type Snapshot = { revision: string; keys: readonly string[] };
type Source = {
  observe(
    owner: string,
    receive: (snapshot: Snapshot) => void,
    ended: (error: unknown) => void,
  ): () => void;
  set(owner: string, key: string, blocked: boolean): Promise<Snapshot>;
};

type State =
  | { status: "loading" | "unavailable" }
  | { status: "ready"; revision: bigint; keys: ReadonlySet<string> };

export function createBlockedUsers(owner: string, source: Source) {
  const store = createStore<State>(() => ({ status: "loading" }));
  const { getState, setState, subscribe } = store;
  let cancel: (() => void) | undefined;
  let generation = 0;
  let writes = Promise.resolve();

  function receive(snapshot: Snapshot) {
    const revision = BigInt(snapshot.revision);
    const state = getState();
    if (state.status === "ready" && revision <= state.revision) return;
    setState({ status: "ready", revision, keys: new Set(snapshot.keys) }, true);
  }

  async function set(input: string, blocked: boolean) {
    const key = parsePublicKey(input);
    if (!key || key === owner) throw new Error("InvalidBlockTarget");
    if (getState().status !== "ready") throw new Error("BlockListUnavailable");
    const current = generation;
    const write = writes.then(async () => {
      if (current !== generation) throw new Error("AccountClosed");
      const snapshot = await source.set(owner, key, blocked);
      if (current !== generation) throw new Error("AccountClosed");
      receive(snapshot);
    });
    writes = write.catch(() => undefined);
    await write;
  }

  return {
    snapshot: getState,
    ready: () => getState().status === "ready",
    has: (key: string) => {
      const state = getState();
      return state.status === "ready" && state.keys.has(key);
    },
    isBlocked: (key: string) => {
      const state = getState();
      return key !== owner && (state.status !== "ready" || state.keys.has(key));
    },
    subscribe,
    start() {
      if (cancel) return;
      const current = ++generation;
      const ended = () => {
        if (current !== generation) return;
        generation++;
        writes = Promise.resolve();
        cancel = undefined;
        setState({ status: "unavailable" }, true);
      };
      try {
        if (getState().status !== "loading")
          setState({ status: "loading" }, true);
        const stop = source.observe(
          owner,
          (snapshot) => {
            if (current === generation) receive(snapshot);
          },
          ended,
        );
        if (current === generation) cancel = stop;
        else stop();
      } catch {
        ended();
      }
    },
    stop() {
      generation++;
      writes = Promise.resolve();
      cancel?.();
      cancel = undefined;
      if (getState().status !== "loading")
        setState({ status: "loading" }, true);
    },
    block: (key: string) => set(key, true),
    unblock: (key: string) => set(key, false),
  };
}

export type BlockedUsers = ReturnType<typeof createBlockedUsers>;
