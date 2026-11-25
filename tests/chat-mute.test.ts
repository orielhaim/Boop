import { describe, expect, test } from "bun:test";
import { isChatMuted, muteChats } from "../src/core/marmot/chat-mute";

describe("chat mutes", () => {
  test("a loaded timed mute expires without a new projection", () => {
    const chat = { muted: true, mutedUntilMs: 1_700_000_000_000 };
    expect(isChatMuted(chat, chat.mutedUntilMs - 1)).toBe(true);
    expect(isChatMuted(chat, chat.mutedUntilMs)).toBe(false);
    expect(isChatMuted(chat, chat.mutedUntilMs + 86_400_000)).toBe(false);
  });

  test("an indefinite mute stays active and a cleared mute stays off", () => {
    expect(isChatMuted({ muted: true, mutedUntilMs: null }, Date.now())).toBe(
      true,
    );
    expect(isChatMuted({ muted: false, mutedUntilMs: null }, Date.now())).toBe(
      false,
    );
  });

  test("every selected chat receives the same absolute deadline", async () => {
    const hour = 3_600_000;
    const earliest = Date.now() + hour;
    const applied = new Map<string, number | null>();
    await muteChats(["direct", "group"], hour, async (group, deadline) => {
      applied.set(group, deadline);
    });
    expect(applied.size).toBe(2);
    expect(applied.get("direct")).toBe(applied.get("group"));
    expect(applied.get("direct")).toBeGreaterThanOrEqual(earliest);
    expect(applied.get("direct")).toBeLessThanOrEqual(Date.now() + hour);
  });

  test("a failed write still lets the rest of an indefinite bulk mute finish", async () => {
    const applied = new Map<string, number | null>();
    await expect(
      muteChats(["removed", "member"], null, async (group, deadline) => {
        if (group === "removed") throw new Error("Chat no longer exists");
        await Promise.resolve();
        applied.set(group, deadline);
      }),
    ).rejects.toThrow("Chat no longer exists");
    expect([...applied]).toEqual([["member", null]]);
  });
});
