import { expect, test } from "bun:test";
import {
  pendingMediaDraft,
  sendOnAttachmentServers,
} from "../src/core/marmot/media-send";

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
