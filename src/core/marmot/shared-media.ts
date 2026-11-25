import type { DownloadTarget } from "@/core/downloads/types";
import type {
  SharedMediaPage,
  SharedMediaQuery,
  SharedMediaRow,
} from "./native";

export type MediaCategory = "visual" | "files" | "music" | "voice";

export function mediaCategory({
  item,
  category,
}: SharedMediaRow): MediaCategory {
  if (item.voice || item.round) return "voice";
  if (category === "image" || category === "video") return "visual";
  if (category === "audio") return "music";
  return "files";
}

export function mediaKey(row: SharedMediaRow) {
  return JSON.stringify([row.group, row.message, row.item.index]);
}

export function mediaTarget(row: SharedMediaRow): DownloadTarget {
  return [row.group, row.message, row.source, row.item.index];
}

type History = {
  page(
    query: SharedMediaQuery,
    cursor?: string,
    baseline?: string,
  ): Promise<SharedMediaPage>;
  changes(baseline: string): Promise<"unchanged" | "additions" | "restart">;
  release(handle: string): Promise<void>;
};

type Collection = {
  rows: readonly SharedMediaRow[];
  phase: "loading" | "ready" | "error";
  more: boolean;
  observedAt: number;
};

export function loadedMediaDate(
  history: Pick<Collection, "rows" | "more" | "phase">,
  query: SharedMediaQuery | undefined,
) {
  const after = query?.after;
  const before = query?.before;
  if (!query || after === undefined || before === undefined) return undefined;
  const oldest = history.rows.at(-1);
  return {
    rows: history.rows.filter(
      (row) =>
        row.at >= after &&
        row.at <= before &&
        (!query.group || row.group === query.group) &&
        (!query.sender || row.sender === query.sender),
    ),
    // A page can end partway through a timestamp shared by multiple attachments.
    complete:
      history.phase !== "error" &&
      (!history.more || (oldest !== undefined && oldest.at < after)),
  };
}

export function createSharedMediaCollection(
  history: History,
  query: SharedMediaQuery,
) {
  const listeners = new Set<() => void>();
  let state: Collection = {
    rows: [],
    phase: "loading",
    more: true,
    observedAt: 0,
  };
  let baseline: string | undefined;
  let cursor: string | undefined;
  let seen = new Set<string>();
  let closed = false;
  let pending: Promise<void> | undefined;
  let refresh:
    | {
        rows: SharedMediaRow[];
        baseline?: string;
        cursor?: string;
        anchor?: string;
      }
    | undefined;

  const publish = (next: Omit<Collection, "observedAt">) => {
    state = { ...next, observedAt: Date.now() };
    for (const notify of listeners) notify();
  };
  const release = (handle?: string | null) => {
    if (handle) void history.release(handle).catch(() => undefined);
  };
  function reset() {
    release(refresh?.baseline);
    release(refresh?.cursor);
    refresh = undefined;
    release(baseline);
    release(cursor);
    baseline = cursor = undefined;
    seen.clear();
    publish({ rows: [], phase: "loading", more: true });
  }
  function perform(operation: () => Promise<void>) {
    if (closed) return Promise.resolve();
    pending ??= operation()
      .catch(() => {
        if (!closed) publish({ ...state, phase: "error" });
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  async function load(retry = true) {
    const consumed = cursor;
    cursor = undefined;
    const page = await history.page(query, consumed, baseline);
    if (closed) {
      release(page.next);
      if (page.baseline !== baseline) release(page.baseline);
      return;
    }
    if (page.restart) {
      release(page.next);
      if (page.baseline !== baseline) release(page.baseline);
      reset();
      if (retry) await load(false);
      else throw new Error("AttachmentHistoryUnavailable");
      return;
    }

    cursor = page.next ?? undefined;
    baseline ??= page.baseline ?? undefined;
    if (page.baseline !== baseline) release(page.baseline);
    const additions = page.rows.filter((row) => {
      const id = mediaKey(row);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    publish({
      rows: additions.length ? [...state.rows, ...additions] : state.rows,
      phase: "ready",
      more: Boolean(cursor),
    });
  }
  async function refreshHead() {
    const oldest = state.rows.at(-1);
    refresh ??= { rows: [], anchor: oldest && mediaKey(oldest) };
    const scan = refresh;
    for (let batch = 0; batch < 3 && !closed; batch++) {
      const consumed = scan.cursor;
      scan.cursor = undefined;
      const page = await history.page(query, consumed, scan.baseline);
      if (closed || page.restart) {
        release(page.next);
        if (page.baseline !== scan.baseline) release(page.baseline);
        if (!closed) {
          reset();
          await load(false);
        }
        return;
      }
      scan.baseline ??= page.baseline ?? undefined;
      if (page.baseline !== scan.baseline) release(page.baseline);
      scan.cursor = page.next ?? undefined;
      scan.rows.push(...page.rows);
      if (
        scan.cursor &&
        scan.anchor &&
        !page.rows.some((row) => mediaKey(row) === scan.anchor)
      )
        continue;
      release(baseline);
      release(cursor);
      refresh = undefined;
      baseline = scan.baseline;
      cursor = scan.cursor;
      seen = new Set(scan.rows.map(mediaKey));
      publish({ rows: scan.rows, phase: "ready", more: Boolean(cursor) });
      return;
    }
  }
  return {
    snapshot: () => state,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    next: () =>
      perform(async () => {
        if (refresh) return refreshHead();
        if (!state.more && state.phase !== "error") return;
        if (state.phase === "error") reset();
        if (state.phase !== "loading") publish({ ...state, phase: "loading" });
        await load();
      }),
    revalidate: () =>
      perform(async () => {
        if (!baseline) return;
        const change = await history
          .changes(baseline)
          .catch(() => "restart" as const);
        if (closed || change === "unchanged") return;
        if (change === "restart") {
          reset();
          await load();
        } else await refreshHead();
      }),
    refresh: () => perform(refreshHead),
    close() {
      closed = true;
      release(cursor);
      release(baseline);
      release(refresh?.cursor);
      release(refresh?.baseline);
      listeners.clear();
    },
  };
}
