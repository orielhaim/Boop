import { expect, test } from "bun:test";
import {
  mediaUploadArguments,
  pendingMediaDraft,
  sendOnAttachmentServers,
  waitForAttachmentForeground,
} from "../src/core/marmot/media-send";

test("picked music crosses the native string-map boundary without undefined image metadata", () => {
  expect(
    mediaUploadArguments([
      {
        path: "/cache/track.mp3",
        name: "track.mp3",
        type: "audio/mpeg",
        dimensions: undefined,
        duration: "120",
      },
      {
        path: "/cache/voice.m4a",
        name: "voice.m4a",
        type: "audio/mp4",
        presentation: "voice",
        waveform: "0,15,31",
      },
    ]),
  ).toStrictEqual([
    {
      path: "/cache/track.mp3",
      name: "track.mp3",
      type: "audio/mpeg",
      duration: "120",
    },
    {
      path: "/cache/voice.m4a",
      name: "voice.m4a",
      type: "audio/mp4",
      presentation: "voice",
      waveform: "0,15,31",
    },
  ]);
});

test("a file returned before Android resumes waits for foreground and is discarded if cancelled", async () => {
  let active = false;
  const listeners = new Set<() => void>();
  const foreground = {
    get: () => active,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
  };
  const controller = new AbortController();
  const cancelled = new AbortController();
  const staged: string[] = [];
  const keep = waitForAttachmentForeground(foreground, controller.signal).then(
    () => staged.push("selected.mp3"),
  );
  const discard = waitForAttachmentForeground(
    foreground,
    cancelled.signal,
  ).then(() => staged.push("cancelled.mp3"));
  expect(staged).toEqual([]);
  cancelled.abort(new Error("picker cancelled"));
  await expect(discard).rejects.toThrow("picker cancelled");

  active = true;
  for (const notify of listeners) notify();
  await keep;
  expect(staged).toEqual(["selected.mp3"]);
  expect(listeners.size).toBe(0);
});

test("an interrupted draft resumes with its original token only after all encrypted copies are staged", () => {
  const token = "00000000-0000-4000-8000-000000000000";
  const first = {
    id: `${token}:2:0:file`,
    size: 300,
    waveform: [0, 0.5, 1],
    duration: 4,
  };
  const second = { id: `${token}:2:1:round`, size: 500, waveform: [] };
  expect(pendingMediaDraft({ text: "", attachments: [first] })).toEqual({
    kind: "incomplete",
  });
  expect(
    pendingMediaDraft({ text: "", attachments: [first, second] }),
  ).toMatchObject({
    kind: "ready",
    token,
    sizes: [300, 500],
  });
});

test("attachment upload skips incompatibility, falls back for pre-admission failures, and stops on uncertain admission", async () => {
  const checked: string[] = [];
  const attempts: string[] = [];
  const ambiguous = { code: "Runtime" };
  const options = {
    origins: ["unavailable", "too-small", "transient", "next", "later"],
    isEnabled: (origin: string) => origin !== "unavailable",
    signal: new AbortController().signal,
    check: async (origin: string) => {
      checked.push(origin);
      if (origin === "too-small") throw new Error("Size limit");
    },
    send: async (origin: string) => {
      attempts.push(origin);
      if (origin === "transient") throw { code: "UploadEndpointFailed" };
      if (origin === "next") throw ambiguous;
      return "accepted";
    },
  };
  await expect(sendOnAttachmentServers(options)).rejects.toBe(ambiguous);
  expect(checked).toEqual(["too-small", "transient", "next"]);
  expect(attempts).toEqual(["transient", "next"]);
});

test("a staged recording keeps its metadata and original send token for inline retry", () => {
  const token = "00000000-0000-4000-8000-000000000000";
  const recording = { size: 300, duration: 3.5, waveform: [0, 15, 31] };
  expect(
    pendingMediaDraft({
      text: "",
      attachments: [{ ...recording, id: `${token}:1:0:voice` }],
    }),
  ).toEqual({
    kind: "ready",
    token,
    sizes: [300],
    voice: { duration: 3.5, waveform: [0, 15, 31] },
  });
  expect(
    pendingMediaDraft({
      text: "",
      attachments: [{ ...recording, id: `${token}:1:0:file` }],
    }),
  ).toEqual({ kind: "ready", token, sizes: [300] });
});

test("a staged video restores its inline preview without requiring the original file", () => {
  const token = "00000000-0000-4000-8000-000000000000";
  expect(
    pendingMediaDraft({
      text: "caption",
      attachments: [
        {
          id: `${token}:1:0:round`,
          size: 1234,
          name: "video-note.mp4",
          type: "video/mp4",
          dimensions: "320x320",
          thumbhash: "poster",
          duration: 8,
        },
      ],
    }),
  ).toEqual({
    kind: "ready",
    token,
    sizes: [1234],
    videoFiles: [
      {
        name: "video-note.mp4",
        type: "video/mp4",
        dimensions: "320x320",
        thumbhash: "poster",
        duration: "8",
        presentation: "round",
      },
    ],
  });
});
