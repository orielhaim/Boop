import { expect, test } from "bun:test";
import { createMarmotSession } from "@/core/marmot/account-session";

const relays = { general: [], inbox: [], discovery: [] };

function waitFor(
  session: ReturnType<typeof createMarmotSession>,
  status: ReturnType<typeof session.status>,
) {
  return new Promise<void>((resolve) => {
    const unsubscribe = session.subscribe(check);
    function check() {
      if (session.status() !== status) return;
      unsubscribe();
      resolve();
    }
    check();
  });
}

test("duplicates share one local open and a transient error retries automatically", async () => {
  let attempts = 0;
  let closed = 0;
  const session = createMarmotSession({
    async open() {
      if (++attempts === 1) throw new Error("temporarily unavailable");
      return "local_ready";
    },
    async close() {
      closed++;
    },
    beforeClose: () => undefined,
    retryDelays: [10],
  });
  session.setRetryEnabled(true);
  await Promise.all([session.start(relays, null), session.start(relays, null)]);
  expect(attempts).toBe(1);
  expect(session.status()).toBe("recovering");
  await waitFor(session, "ready");
  await session.ready();
  expect(attempts).toBe(2);
  await session.stop();
  expect(closed).toBe(1);
});

test("a suspended account holds recovery until it is eligible and reconnects", async () => {
  let attempts = 0;
  const session = createMarmotSession({
    async open() {
      if (++attempts === 1) throw new Error("temporarily unavailable");
      return "local_ready";
    },
    async close() {},
    beforeClose: () => undefined,
    retryDelays: [50],
  });
  session.setRetryEnabled(true);
  await session.start(relays, null);
  session.setRetryEnabled(false);
  session.reconnected();
  await Bun.sleep(65);
  expect(attempts).toBe(1);
  session.setRetryEnabled(true);
  session.reconnected();
  await waitFor(session, "ready");
  expect(attempts).toBe(2);
  await session.stop();
});

test("stopping an account cancels scheduled recovery", async () => {
  let attempts = 0;
  const session = createMarmotSession({
    async open() {
      attempts++;
      throw new Error("temporarily unavailable");
    },
    async close() {},
    beforeClose: () => undefined,
    retryDelays: [30],
  });
  session.setRetryEnabled(true);
  await session.start(relays, null);
  await session.stop();
  await Bun.sleep(45);
  expect(session.status()).toBe("pending");
  expect(attempts).toBe(1);
});

test("identity mismatch fails closed across foreground and network changes", async () => {
  let attempts = 0;
  const session = createMarmotSession({
    async open() {
      attempts++;
      throw Object.assign(new Error("identity mismatch"), {
        code: "IdentityMismatch",
      });
    },
    async close() {},
    beforeClose: () => undefined,
    retryDelays: [10],
  });
  session.setRetryEnabled(true);
  await session.start(relays, null);
  expect(session.status()).toBe("failed");
  session.reconnected();
  await session.start(relays, null);
  await Bun.sleep(20);
  expect(attempts).toBe(1);
  await expect(session.ready()).rejects.toThrow("identity mismatch");
  await session.stop();
});

test("persistent transient errors reach a retry action after bounded attempts", async () => {
  let attempts = 0;
  const session = createMarmotSession({
    async open() {
      if (++attempts < 4) throw new Error("temporarily unavailable");
      return "local_ready";
    },
    async close() {},
    beforeClose: () => undefined,
    retryDelays: [10, 10],
  });
  session.setRetryEnabled(true);
  await session.start(relays, null);
  await waitFor(session, "failed");
  expect(attempts).toBe(3);
  await session.retry();
  expect(session.status()).toBe("ready");
  expect(attempts).toBe(4);
  await session.stop();
});
