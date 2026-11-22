import type { marmot } from "./native";

type NativeMedia = Pick<
  typeof marmot,
  | "attachmentStatus"
  | "downloadAttachment"
  | "openAttachment"
  | "releaseAttachment"
>;
type Lease = NonNullable<Awaited<ReturnType<NativeMedia["openAttachment"]>>>;
export type AttachmentTarget = [
  group: string,
  message: string,
  source: string,
  index: number,
];

type State =
  | {
      kind:
        "checking" | "remote" | "cached" | "preparing" | "failed" | "cancelled";
    }
  | { kind: "downloading"; progress?: number; verifying: boolean }
  | { kind: "local"; lease: Lease };

type Entry = {
  target: AttachmentTarget;
  state: State;
  listeners: Set<() => void>;
  operation?: AbortController;
};

const checking: State = { kind: "checking" };

export function attachmentKey(target: AttachmentTarget) {
  return JSON.stringify(target);
}

export function createAttachmentPresentation(
  native: NativeMedia,
  allowed: (target: AttachmentTarget) => boolean,
) {
  const entries = new Map<string, Entry>();

  function set(entry: Entry, state: State) {
    entry.state = state;
    for (const notify of entry.listeners) notify();
  }

  function release(lease: Lease) {
    void native.releaseAttachment(lease.lease).catch(() => undefined);
  }

  function dispose(entry: Entry) {
    entry.operation?.abort();
    if (entry.state.kind === "local") release(entry.state.lease);
    set(entry, checking);
  }

  function start(entry: Entry, explicit: boolean) {
    if (
      entry.operation ||
      !allowed(entry.target) ||
      entry.state.kind === "local"
    )
      return;
    const operation = new AbortController();
    entry.operation = operation;
    const eligible = () => !operation.signal.aborted && allowed(entry.target);
    set(entry, { kind: "preparing" });
    void (async () => {
      let lease = await native.openAttachment(...entry.target);
      if (!lease && explicit && eligible()) {
        set(entry, { kind: "downloading", verifying: false });
        await native.downloadAttachment(
          ...entry.target,
          (received, total, phase) => {
            if (eligible())
              set(entry, {
                kind: "downloading",
                progress: total
                  ? Math.max(0, Math.min(1, received / total))
                  : undefined,
                verifying:
                  phase.startsWith("verifying") || phase === "decrypting",
              });
          },
          operation.signal,
        );
        if (eligible()) {
          set(entry, { kind: "preparing" });
          lease = await native.openAttachment(...entry.target);
        }
      }
      if (!eligible()) {
        if (lease) release(lease);
        return;
      }
      set(
        entry,
        lease
          ? { kind: "local", lease }
          : { kind: explicit ? "failed" : "remote" },
      );
    })()
      .catch(() => {
        if (eligible()) set(entry, { kind: "failed" });
      })
      .finally(() => {
        if (entry.operation === operation) {
          entry.operation = undefined;
          if (operation.signal.aborted) set(entry, { kind: "cancelled" });
        }
      });
  }

  return {
    subscribe(target: AttachmentTarget, notify: () => void) {
      const key = attachmentKey(target);
      let entry = entries.get(key);
      if (!entry) {
        const created: Entry = {
          target,
          state: checking,
          listeners: new Set(),
        };
        entries.set(key, created);
        entry = created;
        if (allowed(target))
          void native.attachmentStatus(...target).then(
            (ready) => {
              if (entries.get(key) === created && created.state === checking)
                set(created, { kind: ready ? "cached" : "remote" });
            },
            () => {
              if (entries.get(key) === created && created.state === checking)
                set(created, { kind: "failed" });
            },
          );
      }
      entry.listeners.add(notify);
      return () => {
        entry.listeners.delete(notify);
        if (!entry.listeners.size && entries.get(key) === entry) {
          entries.delete(key);
          dispose(entry);
        }
      };
    },
    state: (key: string) => entries.get(key)?.state ?? checking,
    prepare(key: string) {
      const entry = entries.get(key);
      if (entry?.state.kind === "cached") start(entry, false);
    },
    download(key: string) {
      const entry = entries.get(key);
      if (entry) start(entry, true);
    },
    cancel(key: string) {
      entries.get(key)?.operation?.abort();
    },
    async useLocalFile(
      target: AttachmentTarget,
      consume: (lease: Lease) => Promise<void>,
    ) {
      if (!allowed(target)) return;
      const lease = await native.openAttachment(...target);
      if (!lease) throw new Error("MediaUnavailable");
      try {
        if (allowed(target)) await consume(lease);
      } finally {
        release(lease);
      }
    },
    reconcile() {
      for (const [key, entry] of entries) {
        if (!allowed(entry.target)) {
          entries.delete(key);
          dispose(entry);
        }
      }
    },
    stop() {
      for (const entry of entries.values()) dispose(entry);
      entries.clear();
    },
  };
}

export type AttachmentPresentation = ReturnType<
  typeof createAttachmentPresentation
>;
