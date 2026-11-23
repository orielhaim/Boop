import {
  downloadId,
  type DownloadItem,
  type DownloadSource,
  type DownloadTarget,
} from "../downloads/types";
import type { DownloadManager } from "../downloads/manager";
import type { marmot } from "./native";

type NativeMedia = Pick<
  typeof marmot,
  "attachmentStatus" | "openAttachment" | "releaseAttachment"
>;
type Lease = NonNullable<Awaited<ReturnType<NativeMedia["openAttachment"]>>>;
export type AttachmentTarget = DownloadTarget;
export const attachmentKey = downloadId;

type State =
  | {
      kind:
        | "checking"
        | "remote"
        | "cached"
        | "preparing"
        | "failed"
        | "cancelled"
        | "paused";
    }
  | { kind: "downloading"; progress?: number; verifying: boolean }
  | { kind: "local"; lease: Lease };

type Entry = {
  target: AttachmentTarget;
  state: State;
  listeners: Set<() => void>;
  unsubscribe?: () => void;
  job?: DownloadItem;
  openAfterDownload: boolean;
};
const checking: State = { kind: "checking" };

export function createAttachmentPresentation(
  native: NativeMedia,
  downloads: Pick<
    DownloadManager,
    "get" | "subscribe" | "enqueue" | "resume" | "cancel" | "reconcile"
  >,
  authorize: (target: AttachmentTarget) => DownloadSource | undefined,
) {
  const entries = new Map<string, Entry>();
  const allowed = (entry: Entry) =>
    entries.get(attachmentKey(entry.target)) === entry &&
    Boolean(authorize(entry.target));

  function set(entry: Entry, state: State) {
    entry.state = state;
    for (const notify of entry.listeners) notify();
  }

  function release(lease: Lease) {
    void native.releaseAttachment(lease.lease).catch(() => undefined);
  }

  function dispose(entry: Entry) {
    entry.unsubscribe?.();
    if (entry.state.kind === "local") release(entry.state.lease);
    set(entry, checking);
  }

  function prepare(entry: Entry) {
    if (!allowed(entry) || entry.state.kind !== "cached") return;
    set(entry, { kind: "preparing" });
    void native.openAttachment(...entry.target).then(
      (lease) => {
        if (!allowed(entry) || entry.state.kind !== "preparing") {
          if (lease) release(lease);
          return;
        }
        if (!lease && entry.job?.state === "completed")
          void downloads.reconcile();
        set(entry, lease ? { kind: "local", lease } : { kind: "remote" });
      },
      () => {
        if (allowed(entry) && entry.state.kind === "preparing")
          set(entry, { kind: "failed" });
      },
    );
  }

  function update(entry: Entry, key: string) {
    if (!allowed(entry)) return;
    const job = downloads.get(key);
    if (job === entry.job) return;
    const before = entry.job;
    entry.job = job;
    if (!job) {
      if (entry.state.kind === "local") release(entry.state.lease);
      set(entry, { kind: "remote" });
      return;
    }
    if (job.state === "completed") {
      if (before?.state === "completed" || entry.state.kind === "local") return;
      set(entry, { kind: "cached" });
      if (entry.openAfterDownload) prepare(entry);
      entry.openAfterDownload = false;
    } else if (
      job.state === "failed" ||
      job.state === "cancelled" ||
      job.state === "paused"
    ) {
      set(entry, { kind: job.state });
    } else {
      set(entry, {
        kind: "downloading",
        progress: job.total ? Math.min(1, job.received / job.total) : undefined,
        verifying: job.verifying,
      });
    }
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
          openAfterDownload: false,
        };
        entries.set(key, created);
        entry = created;
        created.unsubscribe = downloads.subscribe(() => update(created, key));
        update(created, key);
        if (allowed(created) && created.state === checking)
          void native.attachmentStatus(...target).then(
            (ready) => {
              if (allowed(created) && created.state === checking)
                set(created, { kind: ready ? "cached" : "remote" });
            },
            () => {
              if (allowed(created) && created.state === checking)
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
      if (entry) prepare(entry);
    },
    download(key: string, openAfterDownload = true) {
      const entry = entries.get(key);
      if (
        !entry ||
        entry.state.kind === "local" ||
        entry.state.kind === "cached"
      )
        return;
      const source = authorize(entry.target);
      if (!source) return;
      entry.openAfterDownload = openAfterDownload;
      try {
        if (entry.job?.state === "paused") downloads.resume(key);
        else downloads.enqueue(source);
      } catch {
        set(entry, { kind: "failed" });
      }
    },
    cancel(key: string) {
      void downloads.cancel(key).catch(() => undefined);
    },
    async useLocalFile(
      target: AttachmentTarget,
      consume: (lease: Lease) => Promise<void>,
    ) {
      if (!authorize(target)) return;
      const lease = await native.openAttachment(...target);
      if (!lease) throw new Error("MediaUnavailable");
      try {
        if (authorize(target)) await consume(lease);
      } finally {
        release(lease);
      }
    },
    reconcile() {
      for (const [key, entry] of entries) {
        if (!allowed(entry)) {
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
