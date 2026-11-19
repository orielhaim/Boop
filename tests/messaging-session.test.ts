import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  createConversationFeed,
  unreadBadge,
} from "../src/core/messaging/conversations";
import { createHistoryLoader } from "../src/core/messaging/history";
import {
  createInboxIngestion,
  giftWrapOverlap,
  inboxCatchup,
} from "../src/core/messaging/inbox-sync";
import { seedStressConversations } from "../src/db/chat-stress";
import { createMessagingRepository } from "../src/db/messaging";
import migrations from "../src/db/migrations/bundle";
import * as schema from "../src/db/schema";

function session(sqlite: Database) {
  for (const migration of Object.values(migrations.migrations))
    sqlite.exec(migration);
  const db = drizzle(sqlite, { schema });
  return { db, repo: createMessagingRepository(db) };
}

function incoming(id: string, peerKey = "alice", sentAt = 100) {
  return {
    id,
    peerKey,
    sentAt,
    eventId: `rumor-${id}`,
    direction: "incoming" as const,
    body: id,
    senderKey: peerKey,
    recipientKey: "own",
    replyTo: null,
  };
}

test("hydrates the badge before a list observer mounts, then updates offscreen", async () => {
  using sqlite = new Database(":memory:");
  const { db, repo } = session(sqlite);
  repo.receive(incoming("existing"));
  repo.updateConversations(["alice"], { archived: true, muted: true });
  const reader = createMessagingRepository(db);
  const history = createHistoryLoader(reader);
  const feed = createConversationFeed(reader, history, () => undefined);
  const stop = feed.start();
  const badges: (string | undefined)[] = [];
  const unwatch = feed.subscribeUnread(() =>
    badges.push(unreadBadge(feed.getUnreadCount())),
  );
  try {
    expect(feed.getUnreadCount()).toBe(1);
    expect(feed.getSnapshot()?.rows[0]).toMatchObject({
      unread: 1,
      archived: true,
      muted: true,
    });
    reader.receive(incoming("later", "bob"));
    reader.receive({ ...incoming("later", "bob"), id: "alternate wrap" });
    reader.receive({
      ...incoming("sender copy", "bob"),
      direction: "outgoing",
    });
    expect(badges).toEqual(["2"]);
    await Bun.sleep(25);
    expect(
      feed.getSnapshot()?.rows.reduce((sum, row) => sum + row.unread, 0),
    ).toBe(2);
    reader.markRead("bob", ["later"]);
    reader.deleteConversations(["alice"]);
    expect(badges).toEqual(["2", "1", undefined]);
    expect(unreadBadge(99)).toBe("99");
    expect(unreadBadge(100)).toBe("99+");
  } finally {
    unwatch();
    stop();
    history.dispose();
  }
});

test("navigation shares a pending recent page, keeps unrelated pages and evicts at five", async () => {
  using sqlite = new Database(":memory:");
  const { repo } = session(sqlite);
  repo.receive(incoming("first"));
  const history = createHistoryLoader(repo);
  const prefetch = history.loadRecent("alice");
  expect(history.loadRecent("alice")).toBe(prefetch);
  const opened = history.recent("alice");
  expect(await prefetch).toBe(opened);
  repo.receive(incoming("other", "bob"));
  repo.saveDraft("alice", "Draft", null);
  expect(history.recent("alice")).toBe(opened);
  repo.receive(incoming("newer", "alice", 200));
  expect(history.recent("alice").page.messages.map(({ id }) => id)).toEqual([
    "first",
    "newer",
  ]);
  const before = history.recent("alice");
  for (const key of ["b", "c", "d", "e", "f"]) history.recent(key);
  expect(history.recent("alice")).not.toBe(before);
  const deleting = history.loadRecent("alice");
  repo.deleteConversations(["alice"]);
  expect((await deleting).page.messages).toHaveLength(0);
  const oldIdentityWork = history.loadRecent("bob");
  history.dispose();
  await expect(oldIdentityWork).rejects.toThrow("Messaging session has ended");
});

test("relay checkpoints use overlap, retain longer offline gaps, and audit delayed older wraps", () => {
  const now = 1_800_000_000;
  const day = 86_400;
  expect(inboxCatchup(now, null, null)).toEqual({
    since: undefined,
    checkpoint: `${now}:${now}`,
  });
  expect(inboxCatchup(now, null, String(now - 20)).since).toBe(now - 30 * day);
  expect(inboxCatchup(now, `${now - 60}:${now - day}`, null).since).toBe(
    now - 60 - giftWrapOverlap,
  );
  expect(
    inboxCatchup(now, `${now - 40 * day}:${now - 40 * day}`, null).since,
  ).toBe(now - 43 * day);
  expect(
    inboxCatchup(now, `${now + 1}:${now + 1}`, null).since,
  ).toBeUndefined();
});

test("inbox skips completed envelope replays, retries failed writes and drops cancelled work", async () => {
  const writes: string[] = [];
  let failed = false;
  const queue = createInboxIngestion(
    async (value) => (typeof value === "string" ? value : null),
    (value) => {
      if (value === "retry" && !failed) {
        failed = true;
        throw new Error("Temporary SQLite failure");
      }
      writes.push(value);
    },
  );
  let failures = 0;
  const report = () => {
    failures++;
  };
  queue.receive("a", undefined, () => true, report);
  queue.receive("a", "authenticated", () => true, report);
  queue.receive("a", "authenticated", () => true, report);
  queue.receive("b", "retry", () => true, report);
  queue.receive("b", "retry", () => true, report);
  queue.receive("c", "previous identity", () => false, report);
  await queue.drained();
  expect(writes).toEqual(["authenticated", "retry"]);
  expect(failures).toBe(1);
  expect(queue.queued()).toBe(0);
});

test("100 conversations and 10,000 messages keep local page and summary reads bounded", () => {
  using sqlite = new Database(":memory:");
  const { db, repo } = session(sqlite);
  const { peerKey } = seedStressConversations(db, "own");
  expect(repo.conversations().every((row) => row.lastMessageId !== null)).toBe(
    true,
  );
  expect(unreadBadge(repo.unreadCount())).toBe("99+");
  expect(repo.history(peerKey, { limit: 10_000 }).messages).toHaveLength(300);
  const history = createHistoryLoader(repo);
  const samples = {
    summaries: [] as number[],
    recent: [] as number[],
    warm: [] as number[],
    earlier: [] as number[],
  };
  function timed<T>(key: keyof typeof samples, query: () => T) {
    const start = performance.now();
    const result = query();
    samples[key].push(performance.now() - start);
    return result;
  }
  for (let i = 0; i < 40; i++) {
    expect(timed("summaries", () => repo.conversations())).toHaveLength(100);
    const recent = timed("recent", () => ({
      page: repo.history(peerKey, { limit: 50 }),
      unread: repo.firstUnread(peerKey),
    }));
    const { page } = history.recent(peerKey);
    expect(recent.page.messages.map(({ id }) => id)).toEqual(
      page.messages.map(({ id }) => id),
    );
    expect(timed("warm", () => history.recent(peerKey)).page).toBe(page);
    expect(page.messages).toHaveLength(50);
    if (!page.older) throw new Error("Missing history cursor");
    const previous = timed("earlier", () =>
      history.read(peerKey, { before: page.older ?? undefined, limit: 50 }),
    );
    expect(previous.messages).toHaveLength(50);
    const currentIds = new Set(page.messages.map(({ id }) => id));
    expect(previous.messages.some(({ id }) => currentIds.has(id))).toBe(false);
  }
  const percentiles = Object.fromEntries(
    Object.entries(samples).map(([key, values]) => {
      values.sort((a, b) => a - b);
      return [
        key,
        { p50: values[19]?.toFixed(3), p95: values[37]?.toFixed(3) },
      ];
    }),
  );
  console.info("Desktop SQLite timings (ms)", percentiles);
  history.dispose();
});
