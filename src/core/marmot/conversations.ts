import { AsyncQueuer } from "@tanstack/pacer/async-queuer";
import { Batcher } from "@tanstack/pacer/batcher";
// The root export in 11.5.3 points Metro at a missing minified RN file.
import { LRUCache } from "lru-cache/raw";
import { createStore } from "zustand/vanilla";
import { messagingMetric } from "../messaging/diagnostics";
import { marmotErrorCode } from "./errors";
import type { MarmotConversation, MarmotWindow } from "./native";

type Window = MarmotWindow<MarmotConversation, "older" | "newer" | "latest">;
type View = {
  window?: Window;
  snapshot?: MarmotConversation;
  error?: string;
};
type Entry = {
  key: string;
  group: string;
  target?: string;
  preview?: string;
  consumers: number;
  priority: number;
  controller: AbortController;
  view: View;
  reopened?: boolean;
  unreadPrepared?: boolean;
  positioning?: boolean;
  following?: boolean;
  window?: Window;
  unsubscribe?: () => void;
  closing?: boolean;
  expiry?: ReturnType<typeof setTimeout>;
  reportedPosition?: string;
  scroll?: { generation: string; sequence: string; y: number };
};
type CandidateInput = {
  rows: readonly ConversationCandidate[];
  visibleRows: ReadonlySet<string>;
};

// Leave ten of the sixteen shared native slots outside the coordinator.
const windowBudget = 6;
const speculativeBudget = 3;
const normalWeight = 1024 * 1024;
const reducedWeight = normalWeight / 4;
const maxCandidates = 12;
const keyOf = (group: string, target?: string) =>
  target === undefined ? group : `${group}:${target}`;

export type ConversationCandidate = {
  id: string;
  pinned: boolean;
  unread: number;
  mentioned?: boolean;
  updatedAt: number;
  preview?: { id: string } | null;
};

export function createConversationCache({
  open,
  canOpen,
}: {
  open: (
    group: string,
    options: { target?: string; speculative: boolean; signal: AbortSignal },
  ) => Promise<Window>;
  canOpen: () => boolean;
}) {
  const state = createStore(() => ({ available: false, revision: 0 }));
  const active = new Map<string, Entry>();
  // A permit includes the bridge open and any asynchronous native close.
  const slots = new Set<Entry>();
  const rejected = new Map<string, string | undefined>();
  let idle = createIdle(normalWeight);
  let candidates: readonly ConversationCandidate[] = [];
  let priority = 0;
  let browsing = false;
  let foreground = false;
  let callActive = false;
  let navigation: { group: string; at: number } | undefined;

  const ready = () => state.getState().available && canOpen();
  const canPrefetch = () => ready() && browsing && foreground && !callActive;
  const notify = () => state.setState({});
  const lookup = (key: string) =>
    active.get(key) ??
    idle.peek(key)?.entry ??
    queue
      .peekAllItems()
      .find((entry) => entry.key === key && !entry.controller.signal.aborted);

  function createIdle(maxSize: number) {
    return new LRUCache<string, { entry: Entry; weight: number }>({
      max: 4,
      maxSize,
      sizeCalculation: ({ weight }) => weight,
      disposeAfter({ entry }, key, reason) {
        // Updating the weight of a retained handle keeps the same owner.
        if (reason !== "set" && active.get(key) !== entry) {
          retire(entry);
          notify();
        }
      },
    });
  }

  function retain(entry: Entry) {
    const rows = entry.view.snapshot?.messages ?? [];
    const weight = rows.reduce(
      (bytes, row) =>
        bytes +
        1024 +
        2 * (row.text.length + (row.replyPreview?.text.length ?? 0)),
      1024,
    );
    const previous = idle.peek(entry.key)?.weight ?? 0;
    // Speculation can use spare cache weight. Reserve eviction of viewed
    // conversations for foreground navigation and updates to retained windows.
    if (
      !entry.priority &&
      weight > idle.maxSize - idle.calculatedSize + previous
    ) {
      reject(entry);
      if (!idle.delete(entry.key)) retire(entry);
      return;
    }
    if (previous !== weight) idle.set(entry.key, { entry, weight });
    if (!idle.has(entry.key)) {
      reject(entry);
      retire(entry);
    }
  }

  function releaseWindow(entry: Entry) {
    clearTimeout(entry.expiry);
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
    const window = entry.window;
    entry.window = undefined;
    entry.view = {};
    entry.positioning = false;
    entry.unreadPrepared = false;
    entry.following = false;
    if (window) {
      entry.closing = true;
      void window
        .close()
        .catch(() => undefined)
        .finally(() => {
          entry.closing = false;
          slots.delete(entry);
          pump();
        });
    }
  }

  function retire(entry: Entry) {
    entry.controller.abort();
    releaseWindow(entry);
  }

  function reject(entry: Entry) {
    if (candidates.some(({ id }) => id === entry.group))
      rejected.set(entry.group, entry.preview);
  }

  function publish(entry: Entry, window: Window) {
    if (entry.controller.signal.aborted || !ready()) return;
    clearTimeout(entry.expiry);
    const projection = window.getState();
    if (projection.status === "closed") {
      const code = projection.code;
      if (entry.consumers) {
        releaseWindow(entry);
        const recover =
          !entry.reopened &&
          (code === "WindowClosed" ||
            code === "WindowGenerationChanged" ||
            code === "InvalidWindowProjection");
        entry.reopened = true;
        if (recover) enqueue(entry);
        else entry.view = { error: code };
      } else {
        reject(entry);
        if (!idle.delete(entry.key)) retire(entry);
      }
      notify();
      return;
    }
    const native = projection.snapshot;
    const now = Date.now() / 1000;
    let expiry = Infinity;
    const expired = new Set<string>();
    function trackExpiry(id: string, expiresAt: number | null | undefined) {
      if (expiresAt == null) return;
      if (expiresAt <= now) expired.add(id);
      else expiry = Math.min(expiry, expiresAt);
    }
    for (const row of native.messages) {
      trackExpiry(row.id, row.expiresAt);
      if (row.replyPreview)
        trackExpiry(row.replyPreview.id, row.replyPreview.expiresAt);
    }
    const messages = expired.size
      ? native.messages.flatMap((row) => {
          if (expired.has(row.id)) return [];
          return [
            row.replyPreview && expired.has(row.replyPreview.id)
              ? { ...row, replyPreview: null }
              : row,
          ];
        })
      : native.messages;
    const snapshot =
      messages === native.messages ? native : { ...native, messages };
    entry.view = { ...entry.view, window, snapshot };
    if (entry.consumers && !entry.unreadPrepared) prepareUnread(entry);
    if (Number.isFinite(expiry)) {
      entry.expiry = setTimeout(
        () => publish(entry, window),
        Math.max(
          1,
          Math.min(Math.ceil(expiry * 1000 - Date.now()), 2_147_483_647),
        ),
      );
    }
    if (!entry.consumers) retain(entry);
    if (entry.consumers || expired.size) notify();
    else idleChanges.addItem(null);
  }

  function unreadOutsideWindow(entry: Entry) {
    const snapshot = entry.view.snapshot;
    if (!snapshot) return;
    const id = snapshot.firstUnread;
    if (
      id &&
      !entry.target &&
      !entry.reportedPosition &&
      !snapshot.messages.some((row) => row.id === id)
    )
      return id;
  }

  function prepareUnread(entry: Entry) {
    const window = entry.window;
    if (!window || !entry.view.snapshot || entry.unreadPrepared) return;
    entry.unreadPrepared = true;
    const unread = unreadOutsideWindow(entry);
    if (!unread) return;
    entry.positioning = true;
    void window
      .jump(unread)
      .catch(() => undefined)
      .finally(() => {
        if (entry.window !== window) return;
        entry.positioning = false;
        if (!entry.consumers) entry.unreadPrepared = false;
        notify();
      });
  }

  const queue = new AsyncQueuer(runOpen, {
    started: false,
    maxSize: 16,
    getPriority: (entry) => entry.priority,
    concurrency: (worker) => {
      const running = worker.store.state.activeItems.length;
      const next = worker.peekNextItem();
      if (!ready() || slots.size >= windowBudget || !next || next.closing)
        return running;
      if (next.consumers) return running + 1;
      return canPrefetch() && running === 0 ? 1 : running;
    },
    onSettled: () => queueMicrotask(pump),
  });
  const refresh = new Batcher<CandidateInput | null>(
    (updates) => {
      const latest = updates.findLast((update) => update !== null);
      if (latest) rankCandidates(latest);
      if (!canPrefetch()) return;
      if (queue.peekNextItem() || queue.store.state.activeItems.length) {
        pump();
        return;
      }
      const next = candidates.find(
        ({ id, preview }) =>
          !lookup(id) &&
          (!rejected.has(id) || rejected.get(id) !== preview?.id),
      );
      if (!next) return;
      const speculative = [...idle.rkeys()].filter(
        (key) => idle.peek(key)?.entry.priority === 0,
      );
      if (
        speculative.length >= speculativeBudget ||
        idle.size >= idle.max ||
        slots.size >= windowBudget
      ) {
        const rank = candidates.indexOf(next);
        const victim = speculative.find((key) => {
          const index = candidates.findIndex(({ id }) => id === key);
          return index === -1 || index > rank;
        });
        if (victim) idle.delete(victim);
        return;
      }
      enqueue(makeEntry(next.id, undefined, next.preview?.id));
      pump();
    },
    { wait: 160, maxSize: 12 },
  );
  // MDK already supplies ordered authoritative updates. Coalesce subscriber
  // notifications for warm snapshots while keeping their latest data readable.
  const idleChanges = new Batcher(notify, { wait: 16, maxSize: 12 });

  function pump() {
    if (!ready()) return;
    if (queue.peekNextItem()?.consumers) {
      if (slots.size >= windowBudget) {
        if (![...slots].some((entry) => entry.closing)) idle.pop();
      } else {
        // Pacer can have a tick pending on an active speculative task.
        queue.stop();
      }
    }
    queue.start();
    if (
      canPrefetch() &&
      candidates.length > 0 &&
      !queue.peekNextItem() &&
      !queue.store.state.activeItems.length &&
      refresh.store.state.items.length === 0
    )
      refresh.addItem(null);
  }

  function makeEntry(group: string, target?: string, preview?: string): Entry {
    return {
      key: keyOf(group, target),
      group,
      target,
      preview,
      consumers: 0,
      priority: 0,
      view: {},
      controller: new AbortController(),
    };
  }

  function enqueue(entry: Entry) {
    if (!queue.addItem(entry) && entry.consumers)
      entry.view = { error: "WindowLimit" };
  }

  function removePending(remove: (entry: Entry) => boolean) {
    const pending = queue.peekPendingItems();
    if (!pending.some(remove)) return;
    queue.stop();
    queue.clear();
    for (const entry of pending) {
      if (remove(entry)) {
        if (!entry.consumers) retire(entry);
      } else enqueue(entry);
    }
  }

  async function runOpen(entry: Entry) {
    if (!ready() || entry.controller.signal.aborted) return;
    const speculative = !entry.consumers;
    const signal = entry.controller.signal;
    slots.add(entry);
    const started = performance.now();
    try {
      const window = await open(entry.group, {
        target: entry.target,
        speculative,
        signal,
      }).catch((error: unknown) => {
        if (
          signal.aborted ||
          !ready() ||
          !entry.consumers ||
          (!entry.target && !speculative)
        )
          throw error;
        return open(entry.group, { speculative: false, signal });
      });
      if (signal.aborted || !ready()) {
        await window.close().catch(() => undefined);
        return;
      }
      entry.window = window;
      entry.unsubscribe = window.subscribe(() => publish(entry, window));
      publish(entry, window);
      messagingMetric("conversation projection ready", {
        speculative,
        ms: performance.now() - started,
        rows: entry.view.snapshot?.messages.length ?? 0,
      });
    } catch (error) {
      if (signal.aborted || !ready()) return;
      if (entry.consumers) {
        entry.view = { error: marmotErrorCode(error) };
        notify();
      } else reject(entry);
    } finally {
      if (!entry.window && !entry.closing) slots.delete(entry);
    }
  }

  function cancelSpeculation(keepGroup?: string) {
    refresh.cancel();
    refresh.clear();
    removePending((entry) => !entry.consumers && entry.group !== keepGroup);
    for (const entry of queue.peekActiveItems())
      if (!entry.consumers && entry.group !== keepGroup) retire(entry);
  }

  function rankCandidates({ rows, visibleRows }: CandidateInput) {
    const nearViewport = new Set<string>();
    rows.forEach(({ id }, index) => {
      if (!visibleRows.has(id)) return;
      for (const nearby of rows.slice(Math.max(0, index - 2), index + 3))
        nearViewport.add(nearby.id);
    });
    candidates = [...rows]
      .sort(
        (a, b) =>
          Number(visibleRows.has(b.id)) - Number(visibleRows.has(a.id)) ||
          Number(b.pinned) - Number(a.pinned) ||
          Number(Boolean(b.mentioned)) - Number(Boolean(a.mentioned)) ||
          Number(nearViewport.has(b.id)) - Number(nearViewport.has(a.id)) ||
          Number(b.unread > 0) - Number(a.unread > 0) ||
          b.updatedAt - a.updatedAt,
      )
      .slice(0, maxCandidates);
    // Keep failure suppression bounded to the current ranked candidates.
    for (const id of rejected.keys())
      if (!candidates.some((candidate) => candidate.id === id))
        rejected.delete(id);
    removePending(
      (entry) =>
        !entry.consumers &&
        !candidates.some(
          ({ id, preview }) =>
            id === entry.group && preview?.id === entry.preview,
        ),
    );
    for (const entry of queue.peekActiveItems())
      if (!entry.consumers && !candidates.some(({ id }) => id === entry.group))
        retire(entry);
  }

  function clearIdle() {
    cancelSpeculation();
    idleChanges.cancel();
    idleChanges.clear();
    idle.clear();
    notify();
    pump();
  }
  return {
    subscribe: state.subscribe,
    get(group: string, target?: string) {
      if (!ready()) return;
      const entry = lookup(keyOf(group, target));
      if (
        entry &&
        !entry.positioning &&
        (entry.unreadPrepared || !unreadOutsideWindow(entry))
      )
        return entry.view;
    },
    ready,
    revision: () => state.getState().revision,
    noteNavigation(group: string) {
      navigation = { group, at: performance.now() };
      browsing = false;
      cancelSpeculation(group);
      pump();
    },
    navigationStarted(group: string) {
      const at = navigation?.group === group ? navigation.at : undefined;
      return at !== undefined && performance.now() - at < 2_000
        ? at
        : performance.now();
    },
    position(group: string, target?: string) {
      const entry = lookup(keyOf(group, target));
      if (entry?.reportedPosition)
        return { id: entry.reportedPosition, scroll: entry.scroll };
    },
    rememberOffset(group: string, target: string | undefined, y: number) {
      const entry = active.get(keyOf(group, target));
      const snapshot = entry?.view.snapshot;
      if (entry && snapshot && Number.isFinite(y) && y >= 0) {
        const { generation, sequence } = snapshot;
        entry.scroll = { generation, sequence, y };
      }
    },
    acquire(group: string, target?: string) {
      if (!ready()) return;
      const key = keyOf(group, target);
      const existing = lookup(key);
      const entry = existing ?? makeEntry(group, target);
      entry.consumers++;
      entry.priority = ++priority;
      active.set(key, entry);
      idle.delete(key);
      const pending = queue.peekPendingItems().includes(entry);
      if (pending) removePending((item) => item === entry);
      if (!existing || pending) enqueue(entry);
      prepareUnread(entry);
      pump();
      messagingMetric("conversation acquire", {
        hit: Boolean(entry.view.snapshot),
        queued: pending,
      });
      const acquired = entry;
      let released = false;
      return () => {
        if (released || active.get(key) !== acquired) return;
        released = true;
        acquired.consumers--;
        if (!acquired.consumers && !acquired.positioning)
          acquired.unreadPrepared = false;
        if (!acquired.consumers) {
          active.delete(key);
          if (acquired.window) retain(acquired);
          else {
            retire(acquired);
            removePending((item) => item === acquired);
          }
        }
        notify();
        pump();
      };
    },
    retry(group: string, target?: string) {
      const entry = active.get(keyOf(group, target));
      if (!entry?.view.error || !ready()) return;
      entry.view = {};
      entry.reopened = false;
      entry.unreadPrepared = false;
      entry.priority = ++priority;
      enqueue(entry);
      notify();
      pump();
    },
    remember(group: string, target: string | undefined, visibleId?: string) {
      const entry = active.get(keyOf(group, target));
      if (!entry) return;
      entry.reportedPosition = visibleId;
      if (!visibleId) entry.scroll = undefined;
      if (
        target ||
        visibleId ||
        entry.view.snapshot?.atTail ||
        entry.following ||
        entry.view.snapshot?.hasMoreAfter ||
        !entry.window
      )
        return;
      const window = entry.window;
      entry.following = true;
      void window
        .page("latest")
        .catch(() => undefined)
        .finally(() => {
          if (entry.window === window) entry.following = false;
        });
    },
    setAvailable(next: boolean) {
      if (state.getState().available === next) return;
      state.setState(({ revision }) => ({
        available: next,
        revision: revision + 1,
      }));
      if (!next) {
        navigation = undefined;
        queue.stop();
        queue.clear();
        for (const entry of new Set([
          ...active.values(),
          ...queue.peekActiveItems(),
        ]))
          retire(entry);
        active.clear();
        queue.abort();
        rejected.clear();
        candidates = [];
        clearIdle();
      } else pump();
    },
    setBrowsing(next: boolean) {
      if (browsing === next) return;
      browsing = next;
      if (!next) cancelSpeculation();
      pump();
    },
    setForeground(next: boolean) {
      if (foreground === next) return;
      foreground = next;
      if (!next) {
        // No speculative work while suspended. Keep only mounted consumers.
        clearIdle();
      } else {
        for (const entry of active.values())
          if (entry.window) publish(entry, entry.window);
        pump();
      }
    },
    setCallActive(next: boolean) {
      if (callActive === next) return;
      callActive = next;
      if (next) cancelSpeculation();
      pump();
    },
    reclaimMemory() {
      candidates = [];
      rejected.clear();
      clearIdle();
      idle = createIdle(reducedWeight);
    },
    candidates(
      rows: readonly ConversationCandidate[],
      visibleRows: ReadonlySet<string>,
    ) {
      if (!ready()) return;
      refresh.addItem({ rows, visibleRows });
      pump();
    },
    clearIdle,
  };
}
