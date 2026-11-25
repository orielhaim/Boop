import { expect, test } from "bun:test";
import {
  emptyDateRange,
  selectCalendarDay,
} from "../src/components/kinetik/calendar-range";
import type {
  SharedMediaPage,
  SharedMediaRow,
} from "../src/core/marmot/native";
import {
  createSharedMediaCollection,
  loadedMediaDate,
  mediaCategory,
  mediaKey,
  mediaTarget,
} from "../src/core/marmot/shared-media";

function photo(message: string, index = 0, source = message): SharedMediaRow {
  return {
    group: "group",
    message,
    source,
    sender: "sender",
    at: 100,
    caption: "",
    category: "image",
    local: false,
    item: {
      outcome: "accepted",
      index,
      name: "photo.jpg",
      type: "image/jpeg",
      plaintextHash: "a".repeat(64),
      voice: false,
      round: false,
      size: undefined,
      duration: undefined,
      waveform: undefined,
    },
  };
}

function page(
  rows: SharedMediaRow[],
  next: string | null,
  baseline = "base",
): SharedMediaPage {
  return { rows, next, baseline, restart: false };
}

test("calendar taps form a range in either order and toggle selected endpoints", () => {
  const first = new Date(2026, 10, 30);
  const last = new Date(2026, 11, 2);
  const single = selectCalendarDay(emptyDateRange, last);
  const range = selectCalendarDay(single, first);
  expect(range).toEqual({ start: first, end: last });
  expect(
    selectCalendarDay(selectCalendarDay(emptyDateRange, first), last),
  ).toEqual(range);
  expect(selectCalendarDay(range, first)).toEqual(single);
  const firstOnly = selectCalendarDay(range, last);
  expect(firstOnly).toEqual({ start: first, end: null });
  expect(selectCalendarDay(firstOnly, new Date(2026, 10, 30, 17))).toEqual(
    emptyDateRange,
  );
});

test("a date applies to loaded history immediately without claiming an unfinished day is complete", () => {
  const first = { ...photo("first"), at: 200 };
  const middle = { ...photo("middle"), at: 175 };
  const last = { ...photo("last"), at: 100 };
  const elsewhere = { ...photo("other-group"), group: "other", at: 150 };
  const earlier = { ...photo("earlier"), at: 99 };
  const query = { group: "group", sender: "sender", after: 100, before: 200 };
  const loaded = [first, middle, elsewhere, last];
  expect(
    loadedMediaDate({ phase: "ready", more: true, rows: loaded }, query),
  ).toEqual({ rows: [first, middle, last], complete: false });
  expect(
    loadedMediaDate(
      { phase: "loading", more: true, rows: [...loaded, earlier] },
      query,
    ),
  ).toEqual({ rows: [first, middle, last], complete: true });
  expect(
    loadedMediaDate({ phase: "ready", more: true, rows: [] }, query),
  ).toEqual({ rows: [], complete: false });
  expect(
    loadedMediaDate(
      { phase: "ready", more: false, rows: loaded },
      { ...query, after: 300, before: 400 },
    ),
  ).toEqual({ rows: [], complete: true });
});

test("continues empty candidate pages and keeps album indices and duplicate content", async () => {
  const calls: unknown[] = [];
  const released: string[] = [];
  const collection = createSharedMediaCollection(
    {
      async page(query, cursor, baseline) {
        calls.push([query, cursor, baseline]);
        return cursor
          ? page(
              [photo("one", 2), photo("one", 4), photo("two")],
              null,
              "later",
            )
          : page([], "cursor");
      },
      changes: async () => "unchanged",
      release: async (handle) => {
        released.push(handle);
      },
    },
    { sender: "sender", before: 10 },
  );
  await collection.next();
  expect(collection.snapshot()).toMatchObject({
    phase: "ready",
    rows: [],
    more: true,
  });
  await collection.next();
  expect(collection.snapshot().rows.map(mediaKey)).toEqual([
    '["group","one",2]',
    '["group","one",4]',
    '["group","two",0]',
  ]);
  expect(calls).toEqual([
    [{ sender: "sender", before: 10 }, undefined, undefined],
    [{ sender: "sender", before: 10 }, "cursor", "base"],
  ]);
  collection.close();
  expect(released).toEqual(["later", "base"]);
});

test("invalidates stale entries before a destructive rebuild resolves", async () => {
  const waiting = Promise.withResolvers<SharedMediaPage>();
  const rebuilding = Promise.withResolvers<void>();
  const releases: string[] = [];
  let reads = 0;
  const collection = createSharedMediaCollection(
    {
      async page() {
        if (reads++ === 0) return page([photo("old")], "old-cursor");
        rebuilding.resolve();
        return waiting.promise;
      },
      changes: async () => "restart",
      release: async (handle) => {
        releases.push(handle);
      },
    },
    {},
  );
  await collection.next();
  const rebuild = collection.revalidate();
  await rebuilding.promise;
  expect(collection.snapshot().rows).toEqual([]);
  expect(releases).toEqual(["base", "old-cursor"]);
  waiting.resolve(page([photo("new")], null, "new-base"));
  await rebuild;
  expect(collection.snapshot().rows.map((row) => row.message)).toEqual(["new"]);
  collection.close();
});

test("refreshes additions through the loaded boundary while preserving canonical order", async () => {
  const pages = [
    page([photo("head"), photo("old")], "tail"),
    page([photo("new"), photo("head")], "updated-tail", "updated"),
    page([photo("middle"), photo("old")], "next", "updated"),
  ];
  const calls: (string | undefined)[] = [];
  const collection = createSharedMediaCollection(
    {
      async page(_query, cursor) {
        calls.push(cursor);
        const next = pages.shift();
        if (!next) throw new Error("Unexpected read");
        return next;
      },
      changes: async (base) => (base === "base" ? "additions" : "unchanged"),
      release: async () => {},
    },
    { group: "group" },
  );
  await collection.next();
  await collection.revalidate();
  expect(calls).toEqual([undefined, undefined, "updated-tail"]);
  expect(collection.snapshot().rows.map((row) => row.message)).toEqual([
    "new",
    "head",
    "middle",
    "old",
  ]);
  expect(collection.snapshot().more).toBe(true);
  collection.close();
});

test("retiring one consumer releases late handles and does not affect another consumer", async () => {
  const old = Promise.withResolvers<SharedMediaPage>();
  const releases: string[] = [];
  let opened = 0;
  const history = {
    page: async () =>
      opened++ === 0
        ? old.promise
        : page([photo("visible")], "two", "two-base"),
    changes: async (): Promise<"unchanged"> => "unchanged",
    release: async (handle: string) => {
      releases.push(handle);
    },
  };
  const first = createSharedMediaCollection(history, {});
  const second = createSharedMediaCollection(history, {});
  const starting = first.next();
  await second.next();
  first.close();
  old.resolve(page([photo("retired")], "one", "one-base"));
  await starting;
  expect(first.snapshot().rows).toEqual([]);
  expect(second.snapshot().rows.map((row) => row.message)).toEqual(["visible"]);
  expect(releases).toEqual(["one", "one-base"]);
  second.close();
});

test("targets source versions independently and classifies notes explicitly", () => {
  const original = photo("same", 3, "v1");
  const edit = photo("same", 3, "v2");
  expect(mediaKey(original)).toBe(mediaKey(edit));
  expect(mediaTarget(original)).toEqual(["group", "same", "v1", 3]);
  expect(mediaTarget(edit)).toEqual(["group", "same", "v2", 3]);
  expect(
    mediaCategory({
      ...edit,
      category: "video",
      item: { ...edit.item, round: true },
    }),
  ).toBe("voice");
  expect(mediaCategory({ ...edit, category: "audio" })).toBe("music");
});
