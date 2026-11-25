import { expect, test } from "bun:test";
import { messageContent, quoteText } from "../src/core/marmot/message-content";
import {
  acceptedAttachments,
  delivery,
  message,
} from "../src/core/marmot/message-projection";
import { mergeRows, windowDelta } from "../src/core/marmot/window-projection";

const text = (value: string) => ({ kind: "text", text: value });
const content = {
  truncated: false,
  blocks: [
    {
      kind: "paragraph",
      children: [
        { kind: "bold", children: [text("Hi ")] },
        { kind: "nostr", text: "npub1reference" },
        text(" "),
        {
          kind: "link",
          destination: "https://example.org",
          children: [text("docs")],
        },
        text(" "),
        { kind: "code", text: "@npub1reference" },
      ],
    },
  ],
};
const wireMessage = {
  id: "opaque-message",
  token: "device-local-token",
  sender: "sender",
  text: "raw copy and translation input",
  content,
  sentAt: 1_730_000_000,
  retentionSeconds: "18446744073709551615",
  eventKind: 1111,
  replyTo: "thread-parent",
  thread: { root: "thread-root", parent: "thread-parent" },
  mentions: ["authoritative-account-reference"],
  reactions: [
    { emoji: "👍", users: ["first", "second"], own: true, count: 32 },
  ],
  attachments: [],
  edited: false,
  deleted: false,
  deletionSource: "unknown",
  recipientConfirmed: false,
  historyImport: "backup",
};

test("prepared reply text uses only native mention and formatting nodes", () => {
  const doc = messageContent.parse(content);
  const aliases = new Map([["npub1reference", "Ada"]]);
  expect(quoteText(doc, "raw", aliases)).toBe("Hi @Ada docs @npub1reference");
  expect(quoteText({ ...doc, truncated: true }, "complete raw", aliases)).toBe(
    "complete raw",
  );
});

test("keeps independent conversation semantics and uint64 retention", () => {
  const row = message.parse({
    ...wireMessage,
    replyPreview: {
      id: "thread-parent",
      sender: "author",
      text: "",
      eventKind: 9,
      content,
      deleted: true,
      deletionSource: "admin",
      mentions: [],
    },
  });
  expect(row.retentionSeconds).toBe("18446744073709551615");
  expect(row.thread).toEqual({ root: "thread-root", parent: "thread-parent" });
  expect(row.replyPreview?.deletionSource).toBe("admin");
  expect(row.reactions[0]?.count).toBe(32);
  expect(row.reactions[0]?.users).toEqual(["first", "second"]);
  expect(row.historyImport).toBe("backup");
  expect(row.token).toBe("device-local-token");
});

test("delivery derives from evidence and preserves native failure reasons", () => {
  const pending = message.parse(wireMessage);
  const received = message.parse({ ...wireMessage, recipientConfirmed: true });
  const published = message.parse({ ...wireMessage, sourceId: "source-event" });
  const failed = message.parse({
    ...wireMessage,
    sourceId: "source-event",
    invalidationStatus: "losing_branch",
  });
  expect(delivery(pending)).toBe("pending");
  expect(delivery(received)).toBe("received");
  expect(received.sourceId).toBeUndefined();
  expect(delivery(published)).toBe("published");
  expect(delivery(failed)).toBe("failed");
  expect(failed.invalidationStatus).toBe("losing_branch");
});

test("keeps attachment indices and rejects only unavailable siblings", () => {
  const row = message.parse({
    ...wireMessage,
    attachments: [
      {
        outcome: "accepted",
        index: 0,
        name: "voice",
        type: "audio/ogg",
        metadata: ["13", "3.5", "0,15,31,90", "voice"],
      },
      { outcome: "rejected", index: 1, reason: "unsupported_format" },
      {
        outcome: "accepted",
        index: 2,
        name: "video",
        type: "video/mp4",
        metadata: ["9007199254740992", "Infinity", "", "round"],
      },
    ],
  });
  expect(row.attachments.map(({ outcome, index }) => [outcome, index])).toEqual(
    [
      ["accepted", 0],
      ["rejected", 1],
      ["accepted", 2],
    ],
  );
  const [voice, video] = acceptedAttachments(row);
  expect(voice).toMatchObject({
    size: 13,
    duration: 3.5,
    waveform: [0, 15, 31],
    voice: true,
  });
  expect(video).toMatchObject({
    size: undefined,
    duration: undefined,
    round: true,
  });
});

test("a delta parses only replaced rows and refuses missing or duplicate IDs", () => {
  const row = message.parse(wireMessage);
  const delta = windowDelta.parse({
    field: "messages",
    base: "9007199254740992",
    metadata: {
      generation: "opaque-window",
      sequence: "9007199254740993",
      hasMoreBefore: true,
      hasMoreAfter: false,
    },
    order: [row.id, "new"],
    changed: [{ ...wireMessage, id: "new", token: null }],
  });
  const next = mergeRows([row], delta, message);
  expect(next[0]).toBe(row);
  expect(next[1]?.token).toBeNull();
  expect(mergeRows(next, { ...delta, changed: [] }, message)).toBe(next);
  expect(() =>
    mergeRows([row], { ...delta, order: ["missing"] }, message),
  ).toThrow("InvalidWindowProjection");
  expect(() =>
    mergeRows([row], { ...delta, order: [row.id, row.id] }, message),
  ).toThrow("InvalidWindowProjection");
});
