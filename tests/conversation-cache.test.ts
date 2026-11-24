import { describe, expect, test } from "bun:test";
import { createConversationCache } from "../src/core/marmot/conversations";
import type {
  MarmotConversation,
  MarmotMessage,
  MarmotWindow,
} from "../src/core/marmot/native";

function message(id: string, text = id, expiresAt?: number): MarmotMessage {
  return {
    id,
    text,
    expiresAt,
    sender: "sender",
    sentAt: 1,
    eventKind: 9,
    mentions: [],
    reactions: [],
    attachments: [],
    deleted: false,
    edited: false,
    recipientConfirmed: false,
    deletionSource: "unknown",
  };
}

function snapshot(
  messages: MarmotMessage[],
  sequence = "1",
): MarmotConversation {
  return {
    kind: "conversation",
    generation: "generation",
    sequence,
    messages,
    hasMoreBefore: false,
    hasMoreAfter: false,
    lifecycle: "ready",
    atTail: true,
    authorityReady: false,
    canSend: false,
    invited: false,
    identities: [],
  };
}

function windowFor(initial: MarmotConversation, onJump?: (id: string) => void) {
  type Window = MarmotWindow<MarmotConversation, "older" | "newer" | "latest">;
  let state: ReturnType<Window["getState"]> = {
    status: "ready",
    snapshot: initial,
  };
  let closes = 0;
  const subscribers = new Set<() => void>();
  const window: Window = {
    getState: () => state,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    async close() {
      closes++;
    },
    async page() {
      throw new Error("Unexpected paging");
    },
    async anchor() {
      throw new Error("Unexpected anchor");
    },
    async jump(id) {
      if (!onJump) throw new Error("Unexpected jump");
      onJump(id);
    },
  };
  function publish(next: ReturnType<Window["getState"]>) {
    state = next;
    for (const listener of subscribers) listener();
  }
  return {
    window,
    publish,
    closes: () => closes,
    observed: () => subscribers.size,
  };
}

const candidate = (id: string, extras = {}) => ({
  id,
  pinned: false,
  unread: 0,
  updatedAt: 0,
  ...extras,
});

async function until(check: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() >= deadline)
      throw new Error("Cache condition timed out");
    await Bun.sleep(5);
  }
}

describe("protected conversation cache", () => {
  test("coalesces idle notifications while serving the latest MDK snapshot immediately", async () => {
    const fixture = windowFor(snapshot([message("initial")]));
    const cache = createConversationCache({
      canOpen: () => true,
      async open() {
        return fixture.window;
      },
    });
    cache.setAvailable(true);
    try {
      const release = cache.acquire("chat");
      await until(() => Boolean(cache.get("chat")?.snapshot));
      release?.();
      let notifications = 0;
      const stop = cache.subscribe(() => {
        notifications++;
      });
      fixture.publish({
        status: "ready",
        snapshot: snapshot([message("second")], "2"),
      });
      fixture.publish({
        status: "ready",
        snapshot: snapshot([message("latest")], "3"),
      });
      expect(cache.get("chat")?.snapshot?.messages[0]?.id).toBe("latest");
      expect(notifications).toBe(0);
      await until(() => notifications === 1);
      stop();
    } finally {
      cache.setAvailable(false);
    }
  });

  test("coalesces candidate changes and aborts obsolete speculation without delaying navigation", async () => {
    const pending =
      Promise.withResolvers<ReturnType<typeof windowFor>["window"]>();
    const obsolete = windowFor(snapshot([message("obsolete")]));
    const visible = windowFor(snapshot([message("visible")]));
    const opens: { group: string; signal: AbortSignal }[] = [];
    const cache = createConversationCache({
      canOpen: () => true,
      open(group, { signal }) {
        opens.push({ group, signal });
        return group === "obsolete"
          ? pending.promise
          : Promise.resolve(visible.window);
      },
    });
    try {
      cache.setAvailable(true);
      cache.setForeground(true);
      cache.setBrowsing(true);
      cache.candidates([candidate("superseded")], new Set());
      cache.candidates([candidate("obsolete")], new Set());
      await until(() => opens.length > 0);
      expect(opens.map(({ group }) => group)).toEqual(["obsolete"]);
      cache.noteNavigation("visible");
      cache.acquire("visible");
      await until(() => Boolean(cache.get("visible")?.snapshot));
      expect(opens[0]?.signal.aborted).toBe(true);
      expect(opens[1]?.signal.aborted).toBe(false);
      pending.resolve(obsolete.window);
      await until(() => obsolete.closes() === 1);
      expect(obsolete.observed()).toBe(0);
      expect(cache.get("obsolete")).toBeUndefined();
    } finally {
      pending.resolve(obsolete.window);
      cache.setAvailable(false);
    }
  });

  test("evicts by snapshot weight while protecting active windows and reduces weight after pressure", async () => {
    const windows = new Map<string, ReturnType<typeof windowFor>>();
    const cache = createConversationCache({
      canOpen: () => true,
      async open(group) {
        const fixture = windowFor(
          snapshot([message(group, "x".repeat(300_000))]),
        );
        windows.set(group, fixture);
        return fixture.window;
      },
    });
    cache.setAvailable(true);
    try {
      const releaseA = cache.acquire("A");
      const releaseB = cache.acquire("B");
      await until(() =>
        Boolean(cache.get("A")?.snapshot && cache.get("B")?.snapshot),
      );
      releaseA?.();
      releaseB?.();
      expect(cache.get("A")).toBeUndefined();
      expect(windows.get("A")?.closes()).toBe(1);
      const keepB = cache.acquire("B");
      cache.reclaimMemory();
      expect(cache.get("B")?.snapshot?.messages[0]?.id).toBe("B");
      expect(windows.get("B")?.closes()).toBe(0);
      const releaseC = cache.acquire("C");
      await until(() => Boolean(cache.get("C")?.snapshot));
      releaseC?.();
      expect(cache.get("C")).toBeUndefined();
      expect(windows.get("C")?.closes()).toBe(1);
      keepB?.();
    } finally {
      cache.setAvailable(false);
    }
  });

  test("holds the native permit until eviction closes and admits the latest navigation first", async () => {
    const close = Promise.withResolvers<void>();
    const opens: string[] = [];
    let evicted = false;
    const cache = createConversationCache({
      canOpen: () => true,
      async open(group) {
        opens.push(group);
        const { window } = windowFor(snapshot([message(group)]));
        if (group !== "0") return window;
        return {
          ...window,
          async close() {
            evicted = true;
            await close.promise;
            await window.close();
          },
        };
      },
    });
    cache.setAvailable(true);
    try {
      const held = Array.from({ length: 6 }, (_, index) =>
        cache.acquire(String(index)),
      );
      await until(() => Boolean(cache.get("5")?.snapshot));
      cache.acquire("earlier");
      cache.acquire("latest");
      held[0]?.();
      expect(evicted).toBe(true);
      expect(opens).toHaveLength(6);
      close.resolve();
      await until(() => Boolean(cache.get("latest")?.snapshot));
      expect(opens.at(-1)).toBe("latest");
      expect(opens).not.toContain("earlier");
    } finally {
      close.resolve();
      cache.setAvailable(false);
    }
  });

  test("deduplicates simultaneous consumers, follows native replacements while closed, and reopens synchronously", async () => {
    const fixture = windowFor(snapshot([message("one")]));
    let opens = 0;
    const cache = createConversationCache({
      canOpen: () => true,
      async open() {
        opens++;
        return fixture.window;
      },
    });
    cache.setAvailable(true);
    try {
      const release = cache.acquire("chat");
      const releaseSecond = cache.acquire("chat");
      await until(() => Boolean(cache.get("chat")?.snapshot));
      const original = cache.get("chat")?.snapshot?.messages[0];
      release?.();
      releaseSecond?.();
      const edited = {
        ...message("one", "edited"),
        reactions: [{ emoji: "👍", count: 3, own: false, users: ["sender"] }],
      };
      const newMessage = {
        ...message("two"),
        poll: {
          question: "Which route?",
          multiple: false,
          open: true,
          selected: [],
          options: [{ id: "option", name: "East", votes: 2 }],
        },
      };
      fixture.publish({
        status: "ready",
        snapshot: snapshot([edited, newMessage], "2"),
      });
      const releaseAgain = cache.acquire("chat");
      expect(opens).toBe(1);
      expect(fixture.observed()).toBe(1);
      expect(cache.get("chat")?.snapshot?.messages[0]).not.toBe(original);
      expect(cache.get("chat")?.snapshot?.messages[0]).toBe(edited);
      expect(cache.get("chat")?.snapshot?.messages[1]).toBe(newMessage);
      fixture.publish({
        status: "ready",
        snapshot: snapshot([newMessage], "3"),
      });
      expect(cache.get("chat")?.snapshot?.messages).toEqual([newMessage]);
      releaseAgain?.();
    } finally {
      cache.setAvailable(false);
    }
    expect(fixture.closes()).toBe(1);
    expect(fixture.observed()).toBe(0);
  });

  test("prioritizes visible accepted chats and promotes an in-flight prefetch without reopening", async () => {
    const fixture = windowFor(snapshot([message("prepared")]));
    const opening = Promise.withResolvers<typeof fixture.window>();
    const calls: { group: string; speculative: boolean }[] = [];
    const cache = createConversationCache({
      canOpen: () => true,
      open(group, { speculative }) {
        calls.push({ group, speculative });
        return opening.promise;
      },
    });
    cache.setAvailable(true);
    cache.setForeground(true);
    cache.setBrowsing(true);
    try {
      cache.candidates(
        Array.from({ length: 700 }, (_, index) =>
          candidate(`chat-${index}`, { pinned: index === 1, updatedAt: index }),
        ),
        new Set(["chat-6"]),
      );
      await until(() => calls.length > 0);
      const release = cache.acquire("chat-6");
      cache.setBrowsing(false);
      opening.resolve(fixture.window);
      await until(() => Boolean(cache.get("chat-6")?.snapshot));
      expect(calls).toEqual([{ group: "chat-6", speculative: true }]);
      release?.();
    } finally {
      cache.setAvailable(false);
    }
  });

  test("foreground opens take admission ahead of prefetch and retain active windows under pressure", async () => {
    const windows = new Map<string, ReturnType<typeof windowFor>>();
    const cache = createConversationCache({
      canOpen: () => true,
      async open(group) {
        const fixture = windowFor(snapshot([message(group)]));
        windows.set(group, fixture);
        return fixture.window;
      },
    });
    cache.setAvailable(true);
    try {
      const active = Array.from({ length: 6 }, (_, index) =>
        cache.acquire(`active-${index}`),
      );
      await until(() => Boolean(cache.get("active-5")?.snapshot));
      const next = cache.acquire("next");
      expect(windows.size).toBe(6);
      active[0]?.();
      await until(() => Boolean(cache.get("next")?.snapshot));
      expect(windows.get("active-0")?.closes()).toBe(1);
      expect(windows.get("active-1")?.closes()).toBe(0);
      next?.();
      cache.setForeground(true);
      cache.setForeground(false);
      expect(cache.get("next")).toBeUndefined();
      expect(cache.get("active-1")?.snapshot?.messages[0]?.id).toBe("active-1");
      active[1]?.();
      expect(cache.get("active-1")).toBeUndefined();
      expect(windows.get("active-1")?.closes()).toBe(1);
    } finally {
      cache.setAvailable(false);
    }
  });

  test("idle memory accounts for structured content and grows again after pressure subsides", async () => {
    let now = 1000;
    const cache = createConversationCache({
      canOpen: () => true,
      clock: () => now,
      async open(group) {
        const rows = Array.from({ length: 100 }, (_, index) => ({
          ...message(`${group}-${index}`),
          reactions: [
            {
              emoji: "🧡",
              count: 600,
              own: false,
              users: Array.from({ length: 20 }, (_, i) =>
                (index * 20 + i).toString(16).padStart(64, "0"),
              ),
            },
          ],
        }));
        return windowFor(snapshot(rows)).window;
      },
    });
    cache.setAvailable(true);
    try {
      cache.reclaimMemory();
      const release = cache.acquire("pressured");
      await until(() => Boolean(cache.get("pressured")?.snapshot));
      release?.();
      expect(cache.get("pressured")?.snapshot?.messages[0]?.id).toBeUndefined();
      now += 120_000;
      const recovered = cache.acquire("recovered");
      await until(() => Boolean(cache.get("recovered")?.snapshot));
      recovered?.();
      expect(cache.get("recovered")?.snapshot?.messages[0]?.id).toBe(
        "recovered-0",
      );
    } finally {
      cache.setAvailable(false);
    }
  });

  test("waits for foreground before opening a newly acquired window", async () => {
    let opens = 0;
    const cache = createConversationCache({
      canOpen: () => true,
      async open(group) {
        opens++;
        return windowFor(snapshot([message(group)])).window;
      },
    });
    cache.setForeground(false);
    cache.setAvailable(true);
    try {
      const release = cache.acquire("chat");
      await Bun.sleep(25);
      expect(opens).toBe(0);
      cache.setForeground(true);
      await until(() => Boolean(cache.get("chat")?.snapshot));
      expect(opens).toBe(1);
      release?.();
    } finally {
      cache.setAvailable(false);
    }
  });

  test("reopens an acquired window when its in-flight open fails during suspension", async () => {
    const pending =
      Promise.withResolvers<ReturnType<typeof windowFor>["window"]>();
    let opens = 0;
    const cache = createConversationCache({
      canOpen: () => true,
      open(group) {
        opens++;
        return opens === 1
          ? pending.promise
          : Promise.resolve(windowFor(snapshot([message(group)])).window);
      },
    });
    cache.setAvailable(true);
    try {
      const release = cache.acquire("chat");
      await until(() => opens === 1);
      cache.setForeground(false);
      pending.reject(new Error("suspended"));
      await Bun.sleep(25);
      expect(opens).toBe(1);
      expect(cache.get("chat")?.error).toBeUndefined();
      cache.setForeground(true);
      await until(() => Boolean(cache.get("chat")?.snapshot));
      expect(opens).toBe(2);
      release?.();
    } finally {
      pending.reject(new Error("closed"));
      cache.setAvailable(false);
    }
  });

  test("resumes prefetch with the latest candidates after backgrounding during the debounce", async () => {
    const opens: string[] = [];
    const cache = createConversationCache({
      canOpen: () => true,
      async open(group) {
        opens.push(group);
        return windowFor(snapshot([message(group)])).window;
      },
    });
    cache.setAvailable(true);
    cache.setBrowsing(true);
    try {
      cache.candidates([candidate("before-background")], new Set());
      cache.setForeground(false);
      cache.candidates([candidate("while-backgrounded")], new Set());
      await Bun.sleep(180);
      expect(opens).toEqual([]);
      cache.setForeground(true);
      await until(() => opens.length > 0);
      expect(opens).toEqual(["while-backgrounded"]);
    } finally {
      cache.setAvailable(false);
    }
  });

  test("retries a promoted speculative timeout with the interactive deadline and preserves the browsing anchor", async () => {
    const attempt =
      Promise.withResolvers<ReturnType<typeof windowFor>["window"]>();
    const fixture = windowFor(snapshot([message("anchor")]));
    const calls: boolean[] = [];
    const cache = createConversationCache({
      canOpen: () => true,
      open(_group, { speculative }) {
        calls.push(speculative);
        return speculative ? attempt.promise : Promise.resolve(fixture.window);
      },
    });
    cache.setAvailable(true);
    cache.setForeground(true);
    cache.setBrowsing(true);
    try {
      cache.candidates([candidate("chat")], new Set());
      await until(() => calls.length === 1);
      const release = cache.acquire("chat");
      attempt.reject(new Error("TimeLimit"));
      await until(() => Boolean(cache.get("chat")?.snapshot));
      cache.remember("chat", undefined, "anchor");
      cache.rememberOffset("chat", undefined, 241);
      release?.();
      const releaseAgain = cache.acquire("chat");
      expect(calls).toEqual([true, false]);
      expect(cache.position("chat")).toEqual({
        id: "anchor",
        scroll: { y: 241, generation: "generation", sequence: "1" },
      });
      releaseAgain?.();
    } finally {
      cache.setAvailable(false);
    }
  });

  test("keeps a speculative window at the tail and resolves an out-of-window unread target only when opened", async () => {
    const jumps: string[] = [];
    const latest = { ...snapshot([message("tail")]), firstUnread: "unread" };
    const fixture = windowFor(latest, (id) => {
      jumps.push(id);
      fixture.publish({
        status: "ready",
        snapshot: {
          ...latest,
          ...snapshot([message(id)], "2"),
          firstUnread: id,
          hasMoreAfter: true,
          atTail: false,
        },
      });
    });
    const cache = createConversationCache({
      canOpen: () => true,
      async open() {
        return fixture.window;
      },
    });
    cache.setAvailable(true);
    cache.setForeground(true);
    cache.setBrowsing(true);
    try {
      cache.candidates([candidate("chat", { unread: 64 })], new Set());
      await until(() => fixture.observed() === 1);
      expect(jumps).toEqual([]);
      expect(cache.get("chat")?.snapshot).toBeUndefined();
      const release = cache.acquire("chat");
      await until(() => Boolean(cache.get("chat")?.snapshot));
      expect(jumps).toEqual(["unread"]);
      expect(cache.get("chat")?.snapshot?.messages[0]?.id).toBe("unread");
      release?.();
    } finally {
      cache.setAvailable(false);
    }
  });

  test("memory reclamation stops pending speculative work and drops its eventual result", async () => {
    const fixture = windowFor(snapshot([message("candidate")]));
    const pending = Promise.withResolvers<typeof fixture.window>();
    let opens = 0;
    const cache = createConversationCache({
      canOpen: () => true,
      open() {
        opens++;
        return pending.promise;
      },
    });
    cache.setAvailable(true);
    cache.setForeground(true);
    cache.setBrowsing(true);
    cache.candidates([candidate("chat")], new Set());
    await until(() => opens === 1);
    cache.setForeground(false);
    pending.resolve(fixture.window);
    await until(() => fixture.closes() === 1);
    expect(cache.get("chat")).toBeUndefined();
    expect(fixture.observed()).toBe(0);
    cache.setAvailable(false);
  });

  test("discarded account results never install after lock or replacement", async () => {
    const stale = windowFor(snapshot([message("private")]));
    const fresh = windowFor(snapshot([message("new session")]));
    const previous = Promise.withResolvers<typeof stale.window>();
    let calls = 0;
    const cache = createConversationCache({
      canOpen: () => true,
      open() {
        return ++calls === 1 ? previous.promise : Promise.resolve(fresh.window);
      },
    });
    cache.setAvailable(true);
    const releaseOld = cache.acquire("chat");
    cache.setAvailable(false);
    cache.setAvailable(true);
    const releaseCurrent = cache.acquire("chat");
    try {
      await until(() => Boolean(cache.get("chat")?.snapshot));
      previous.resolve(stale.window);
      releaseOld?.();
      await until(() => stale.closes() === 1);
      expect(cache.get("chat")?.snapshot?.messages[0]?.text).toBe(
        "new session",
      );
      expect(stale.observed()).toBe(0);
    } finally {
      releaseCurrent?.();
      cache.setAvailable(false);
    }
  });

  test("replaces an invalid active native window once without using its previous projection", async () => {
    const original = windowFor(snapshot([message("old")]));
    const recovered = windowFor(snapshot([message("current")]));
    let opens = 0;
    const cache = createConversationCache({
      canOpen: () => true,
      async open() {
        return ++opens === 1 ? original.window : recovered.window;
      },
    });
    cache.setAvailable(true);
    const release = cache.acquire("chat");
    try {
      await until(() => Boolean(cache.get("chat")?.snapshot));
      original.publish({ status: "closed", code: "WindowGenerationChanged" });
      expect(cache.get("chat")?.snapshot).toBeUndefined();
      await until(
        () => cache.get("chat")?.snapshot?.messages[0]?.id === "current",
      );
      recovered.publish({ status: "closed", code: "InvalidWindowProjection" });
      expect(cache.get("chat")?.error).toBe("InvalidWindowProjection");
      expect(opens).toBe(2);
      expect(original.observed()).toBe(0);
    } finally {
      release?.();
      cache.setAvailable(false);
    }
  });

  test("filters expired rows immediately, protects quoted content, and keeps nonexpired rows", async () => {
    const expiresAt = Date.now() / 1000 + 0.25;
    const quote = {
      ...message("quote"),
      replyTo: "secret",
      replyPreview: {
        ...message("secret", "private"),
        expiresAt,
        content: { blocks: [], truncated: false },
      },
    } satisfies MarmotMessage;
    const original = snapshot([
      message("another-expired-row", "private", expiresAt),
      quote,
    ]);
    const fixture = windowFor(original);
    const cache = createConversationCache({
      canOpen: () => true,
      async open() {
        return fixture.window;
      },
    });
    cache.setAvailable(true);
    try {
      const release = cache.acquire("chat");
      await until(() => Boolean(cache.get("chat")?.snapshot));
      expect(cache.get("chat")?.snapshot?.messages).toHaveLength(2);
      release?.();
      await until(() => cache.get("chat")?.snapshot?.messages.length === 1);
      expect(cache.get("chat")?.snapshot?.messages[0]?.replyPreview).toBeNull();
      expect(fixture.window.getState()).toEqual({
        status: "ready",
        snapshot: original,
      });
    } finally {
      cache.setAvailable(false);
    }
  });
});
