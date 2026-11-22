import { expect, test } from "bun:test";
import {
  editMentionText,
  insertMention,
  mentionAt,
  mentionWireOffset,
  projectMentions,
} from "../src/core/messaging/mentions";

test("group member suggestions follow the mention at the caret", () => {
  expect(mentionAt("@", { start: 1, end: 1 })).toEqual({
    query: "",
    start: 0,
    end: 1,
  });
  expect(mentionAt("Hello @נועה", { start: 9, end: 9 })).toEqual({
    query: "נו",
    start: 6,
    end: 11,
  });
  expect(mentionAt("a@example.com", { start: 13, end: 13 })).toBeUndefined();
  expect(mentionAt("@alice ", { start: 7, end: 7 })).toBeUndefined();
  expect(mentionAt("@alice", { start: 1, end: 6 })).toBeUndefined();
});

test("names in the composer and timeline are projections of the stored IDs", () => {
  const first = `npub1${"q".repeat(58)}`;
  const second = `npub1${"p".repeat(58)}`;
  const names = new Map([
    [first, "Alice"],
    [second, "Bob"],
  ]);
  const wire = `Hello nostr:${first} and @${second}`;
  const projected = projectMentions(wire, names);
  expect(projected.text).toBe("Hello @Alice and @Bob");
  expect(editMentionText(projected, "Hello @Alice! and @Bob")).toBe(
    `Hello nostr:${first}! and @${second}`,
  );
  expect(editMentionText(projected, "Hello @Alicia and @Bob")).toBe(
    `Hello @Alicia and @${second}`,
  );
  expect(editMentionText(projected, "Hello @Bob")).toBe(`Hello @${second}`);
  expect(mentionWireOffset(projected, "Hello @Alice and ".length)).toBe(
    `Hello nostr:${first} and `.length,
  );
});

test("selecting a member updates the active token and preserves the rest of the draft", () => {
  const draft = "Hi @Alice and Bob";
  const range = mentionAt(draft, { start: 6, end: 6 });
  expect(range).toEqual({ query: "Al", start: 3, end: 9 });
  if (!range) throw new Error("Expected an active mention");
  const result = insertMention(draft, range, "npub1member");
  expect(result.text).toBe("Hi nostr:npub1member and Bob");
  expect(result.text.slice(result.caret)).toBe("and Bob");
});
