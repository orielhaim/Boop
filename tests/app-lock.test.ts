import { expect, test } from "bun:test";
import { createAppLock, lockTimeouts } from "../src/core/security/app-lock";

function device() {
  const preferences = new Map<string, string>();
  let time = 100;
  let prompt: { approve: () => void; cancel: () => void } | undefined;
  let promptCount = 0;
  let captureBlocked = false;
  function launch() {
    return createAppLock({
      read: (key) => preferences.get(key) ?? null,
      write: (key, value) => {
        preferences.set(key, value);
      },
      authenticate: () => {
        promptCount++;
        return new Promise<void>((approve, reject) => {
          prompt = { approve, cancel: () => reject(new Error("Cancelled")) };
        });
      },
      protect: async (enabled) => {
        captureBlocked = enabled;
      },
      startActive: true,
      now: () => time,
    });
  }
  return {
    launch,
    advance(ms: number) {
      time += ms;
    },
    approve: () => prompt?.approve(),
    cancel: () => prompt?.cancel(),
    promptCount: () => promptCount,
    captureBlocked: () => captureBlocked,
  };
}

test("enable requires successful authentication and the next process starts locked", async () => {
  const native = device();
  const lock = native.launch();
  const cancelled = lock.change("enable");
  native.cancel();
  await cancelled;
  expect(lock.getState()).toMatchObject({
    enabled: false,
    locked: false,
    error: "Cancelled",
  });
  const enabling = lock.change("enable");
  await lock.change("enable");
  expect(native.promptCount()).toBe(2);
  native.approve();
  await enabling;
  expect(lock.getState()).toMatchObject({ enabled: true, locked: false });
  expect(native.captureBlocked()).toBe(true);
  const cold = native.launch();
  expect(cold.getState()).toMatchObject({ enabled: true, locked: true });
  const unlock = cold.change("unlock");
  native.cancel();
  await unlock;
  expect(cold.getState().locked).toBe(true);
});

for (const timeout of lockTimeouts) {
  test(`locks at the configured ${timeout} ms boundary`, async () => {
    const native = device();
    const lock = native.launch();
    const enable = lock.change("enable");
    native.approve();
    await enable;
    lock.setTimeout(timeout);
    if (timeout > 0) {
      lock.setActive(false);
      native.advance(timeout - 1);
      lock.setActive(true);
      expect(lock.getState().locked).toBe(false);
    }
    lock.setActive(false);
    native.advance(timeout);
    lock.setActive(true);
    expect(lock.getState().locked).toBe(true);
    expect(native.launch().getState().timeout).toBe(timeout);
  });
}

test("native prompt transitions do not re-lock and disabling needs a new successful prompt", async () => {
  const native = device();
  const lock = native.launch();
  const enable = lock.change("enable");
  native.approve();
  await enable;
  lock.setActive(false);
  lock.setActive(true);
  const unlock = lock.change("unlock");
  lock.setActive(false);
  native.approve();
  await unlock;
  expect(lock.getState()).toMatchObject({ active: false, locked: false });
  lock.setActive(true);
  expect(lock.getState()).toMatchObject({ active: true, locked: false });
  const cancel = lock.change("disable");
  native.cancel();
  await cancel;
  expect(lock.getState().enabled).toBe(true);
  const disable = lock.change("disable");
  native.approve();
  await disable;
  expect(native.captureBlocked()).toBe(false);
  expect(native.launch().getState()).toMatchObject({
    enabled: false,
    locked: false,
  });
});

test("a failed native screen shield keeps the gate closed", async () => {
  const lock = createAppLock({
    read: () => "0",
    write: () => {
      throw new Error("Unexpected preference write");
    },
    authenticate: async () => {},
    protect: async () => {
      throw new Error("No secure window");
    },
    startActive: true,
  });
  await lock.change("unlock");
  expect(lock.getState()).toMatchObject({
    enabled: true,
    locked: true,
    error: "No secure window",
  });
});

test("cold launch prompts once and cancellation leaves manual retry available", async () => {
  const native = device();
  const lock = native.launch();
  const enabling = lock.change("enable");
  native.approve();
  await enabling;

  const cold = native.launch();
  cold.autoUnlock();
  cold.autoUnlock();
  native.cancel();
  await Promise.resolve();
  cold.setActive(false);
  cold.setActive(true);
  cold.autoUnlock();
  expect(native.promptCount()).toBe(2);
  expect(cold.getState().locked).toBe(true);

  const manual = cold.change("unlock");
  native.approve();
  await manual;
  expect(cold.getState().locked).toBe(false);
  cold.setActive(false);
  cold.setActive(true);
  cold.autoUnlock();
  expect(native.promptCount()).toBe(4);
  native.cancel();
});
