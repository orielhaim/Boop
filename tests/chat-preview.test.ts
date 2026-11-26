import { expect, test } from "bun:test";
import {
  chatPreview,
  presentChatPreview,
} from "../src/core/marmot/chat-preview";

function preview(fields: Partial<ReturnType<typeof chatPreview.parse>>) {
  return presentChatPreview(
    chatPreview.parse({ id: "message", sender: "peer", kind: 9, ...fields }),
  );
}

test("chat previews classify attachments from native metadata and keep the caption", () => {
  expect(
    preview({
      attachmentKind: "photo",
      attachmentCount: 2,
      text: "At the beach",
    }),
  ).toEqual({
    kind: "activity",
    icon: "media",
    label: "messages:chatPreview.photo",
    count: 2,
    detail: "At the beach",
  });
  expect(preview({ attachmentKind: "video" })).toMatchObject({
    icon: "camera",
    label: "messages:chatPreview.video",
  });
  expect(
    preview({ attachmentKind: "video", attachmentPresentation: "round" }),
  ).toMatchObject({ label: "messages:chatPreview.videoNote" });
  expect(preview({ attachmentKind: "audio" })).toMatchObject({
    icon: "audio",
    label: "messages:chatPreview.audio",
  });
  expect(
    preview({ attachmentKind: "audio", attachmentPresentation: "voice" }),
  ).toMatchObject({ icon: "microphone", label: "messages:voiceMessage" });
  expect(preview({ attachmentKind: "file" })).toMatchObject({
    icon: "file",
    label: "messages:chatPreview.file",
  });
  expect(preview({ attachmentKind: "mixed" })).toMatchObject({
    icon: "attach",
    label: "messages:chatPreview.attachments",
  });
  expect(preview({ sticker: true })).toMatchObject({
    icon: "sticker",
    label: "messages:chatPreview.sticker",
  });
});

test("chat previews use authenticated group activity metadata", () => {
  expect(
    preview({
      kind: 1210,
      text: "raw",
      system: { type: "group_renamed", name: "Hiking" },
    }),
  ).toEqual({
    kind: "activity",
    icon: "edit",
    label: "messages:marmot.eventGroupRenamed",
    detail: "Hiking",
    system: true,
  });
  expect(
    preview({ kind: 1210, system: { type: "member_added" } }),
  ).toMatchObject({ label: "messages:marmot.eventMemberAdded", system: true });
  expect(preview({ kind: 1210, text: "unauthenticated data" })).toBeUndefined();
});

test("chat previews avoid exposing special event payloads", () => {
  expect(preview({ kind: 24881, text: "ciphertext" })).toEqual({
    kind: "activity",
    icon: "timedLock",
    label: "messages:lockedMessage",
  });
  expect(preview({ kind: 24883, text: '{"latitude":31}' })).toEqual({
    kind: "activity",
    icon: "location",
    label: "messages:marmot.locationPreview",
  });
  expect(preview({ kind: 1068, text: "Where should we go?" })).toMatchObject({
    icon: "poll",
    detail: "Where should we go?",
  });
  expect(preview({ deleted: true, text: "deleted body" })).toEqual({
    kind: "activity",
    icon: "trash",
    label: "messages:marmot.removedMessage",
    system: true,
  });
  expect(
    preview({ kind: 24884, text: "call signalling payload" }),
  ).toBeUndefined();
  expect(preview({ kind: 1111, text: "  Regular reply  " })).toEqual({
    kind: "text",
    text: "Regular reply",
  });
});
