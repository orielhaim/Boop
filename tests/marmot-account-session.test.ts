import { expect, test } from "bun:test";
import { createMarmotSession } from "@/core/marmot/account-session";

const discovery: string[] = [];

test("automatically recovers a transient open without a connectivity event", async () => {
  let attempts = 0;
  const ready = Promise.withResolvers<void>();
  const session = createMarmotSession({
    async open() {
      if (++attempts === 1) throw new Error("temporarily unavailable");
      return "local_ready";
    },
    async close() {},
    beforeClose: () => undefined,
  });
  const unsubscribe = session.subscribe(() => {
    if (session.status() === "ready") ready.resolve();
  });
  try {
    await session.start(discovery, null);
    expect(session.status()).toBe("failed");
    await Promise.race([ready.promise, Bun.sleep(700)]);
    expect(session.status()).toBe("ready");
    expect(attempts).toBe(2);
  } finally {
    unsubscribe();
    await session.stop();
  }
});

test("coalesces duplicate opens and reconnects after a transient failure", async () => {
  let attempts = 0;
  const session = createMarmotSession({
    async open() {
      if (++attempts === 1) throw new Error("temporarily unavailable");
      return "local_ready";
    },
    async close() {},
    beforeClose: () => undefined,
  });
  await Promise.all([
    session.start(discovery, null),
    session.start(discovery, null),
  ]);
  expect(attempts).toBe(1);
  expect(session.status()).toBe("failed");
  session.reconnected();
  await session.ready();
  expect(attempts).toBe(2);
  await session.stop();
});

test("an open that completes after stop is drained without ever publishing ready", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const phases: string[] = [];
  const session = createMarmotSession({
    async open() {
      entered.resolve();
      await release.promise;
      return "local_ready";
    },
    async close() {
      phases.push("closed");
    },
    async beforeClose() {
      phases.push("drained");
    },
  });
  session.subscribe(() => phases.push(session.status()));
  const opening = session.start(discovery, null);
  await entered.promise;
  const closing = session.stop();
  release.resolve();
  await Promise.all([opening, closing]);
  expect(phases).toEqual([
    "pending",
    "pending",
    "drained",
    "closed",
    "pending",
  ]);
  await expect(session.ready()).rejects.toThrow("AccountClosed");
});

test("configuration changes drain the previous session before opening its replacement", async () => {
  const phases: (string | null)[] = [];
  const session = createMarmotSession({
    async open(_, origin) {
      phases.push(origin);
      return "network_ready";
    },
    async close() {
      phases.push("closed");
    },
    async beforeClose() {
      phases.push("drained");
    },
  });
  await session.start(discovery, null);
  await session.start(discovery, "https://media.example.com");
  expect(phases).toEqual([
    null,
    "drained",
    "closed",
    "https://media.example.com",
  ]);
  await session.stop();
});

test("a signed-out account stays unavailable when connectivity returns", async () => {
  let attempts = 0;
  const session = createMarmotSession({
    async open() {
      attempts++;
      throw Object.assign(new Error("signed out"), {
        code: "AccountSignedOut",
      });
    },
    async close() {},
    beforeClose: () => undefined,
  });
  await session.start(discovery, null);
  session.reconnected();
  await expect(session.ready()).rejects.toThrow("signed out");
  await Bun.sleep(350);
  expect(attempts).toBe(1);
  await session.stop();
});

test("closing a failed session cancels automatic restart", async () => {
  let attempts = 0;
  const session = createMarmotSession({
    async open() {
      attempts++;
      throw new Error("temporarily unavailable");
    },
    async close() {},
    beforeClose: () => undefined,
  });
  await session.start(discovery, null);
  await session.stop();
  await Bun.sleep(350);
  expect(attempts).toBe(1);
  expect(session.status()).toBe("pending");
});
