import { expect, test } from "bun:test";
import { createGroupCallWindows } from "../src/core/marmot/group-call-windows";
import type { marmot } from "../src/core/marmot/native";

type Window = Awaited<ReturnType<typeof marmot.openGroupCall>>;

function fixture(generation: string) {
  let closes = 0;
  const state: ReturnType<Window["getState"]> = {
    status: "ready",
    snapshot: {
      kind: "groupCall",
      generation,
      sequence: "1",
      hasMoreBefore: false,
      hasMoreAfter: false,
      announcements: [],
    },
  };
  const window: Window = {
    getState: () => state,
    subscribe: () => () => {},
    refresh() {},
    async page() {},
    async anchor() {},
    async jump() {},
    async close() {
      closes++;
    },
  };
  return { window, closes: () => closes };
}

test("chat and profile hand off one live group-call window", async () => {
  const native = fixture("first");
  const opening = Promise.withResolvers<Window>();
  const opened: string[] = [];
  const windows = createGroupCallWindows(
    (group) => {
      opened.push(group);
      return opening.promise;
    },
    () => 1,
  );

  const chat = windows.acquire("group");
  const profile = windows.acquire("group");
  expect(opened).toEqual(["group"]);
  opening.resolve(native.window);

  const chatWindow = await chat;
  const profileWindow = await profile;
  expect(windows.peek("group")?.getState()).toEqual({
    status: "ready",
    snapshot: {
      kind: "groupCall",
      generation: "first",
      sequence: "1",
      hasMoreBefore: false,
      hasMoreAfter: false,
      announcements: [],
    },
  });
  await profileWindow.close();
  await profileWindow.close();
  expect(native.closes()).toBe(0);
  await chatWindow.close();
  expect(native.closes()).toBe(1);
  expect(windows.peek("group")).toBeUndefined();
});

test("a retired runtime's window cannot be reused or remove its replacement", async () => {
  let revision = 1;
  const retired = fixture("retired");
  const replacement = fixture("replacement");
  const windows = createGroupCallWindows(
    async () => (revision === 1 ? retired.window : replacement.window),
    () => revision,
  );

  const previous = await windows.acquire("group");
  revision++;
  expect(windows.peek("group")).toBeUndefined();
  const current = await windows.acquire("group");
  await previous.close();
  expect(retired.closes()).toBe(1);
  expect(windows.peek("group")).toBe(replacement.window);
  await current.close();
  expect(replacement.closes()).toBe(1);
});
