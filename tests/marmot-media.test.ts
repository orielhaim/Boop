import { expect, test } from "bun:test";
import {
  attachmentKey,
  createAttachmentPresentation,
  type AttachmentTarget,
} from "../src/core/marmot/attachment-presentation";
import {
  pendingMediaDraft,
  sendOnAttachmentServers,
} from "../src/core/marmot/media-send";

const local = {
  path: "/verified/image.jpg",
  lease: "lease",
  name: "image.jpg",
  type: "image/jpeg",
};
const target: AttachmentTarget = ["chat", "message", "source", 0];
const key = attachmentKey(target);

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

test("attachment presentation never requests a remote body while mounted and deduplicates explicit download", async () => {
  let requests = 0;
  let opens = 0;
  let cached = false;
  const body = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const released: string[] = [];
  const adapter = createAttachmentPresentation(
    {
      attachmentStatus: async () => cached,
      openAttachment: async () => {
        opens++;
        return cached ? local : null;
      },
      releaseAttachment: async (lease) => {
        released.push(lease);
      },
      downloadAttachment: async (
        _group,
        _message,
        _source,
        _index,
        progress,
      ) => {
        requests++;
        progress(1, 2, "verifying_ciphertext");
        await body.promise;
        cached = true;
      },
    },
    () => true,
  );

  const off = adapter.subscribe(target, () => {
    if (adapter.state(key).kind === "local") ready.resolve();
  });
  const offGallery = adapter.subscribe(target, () => {});
  await Promise.resolve();
  adapter.prepare(key);
  expect(adapter.state(key)).toEqual({ kind: "remote" });
  expect(requests).toBe(0);
  expect(opens).toBe(0);
  adapter.download(key);
  adapter.download(key);
  await Promise.resolve();
  expect(requests).toBe(1);
  expect(adapter.state(key)).toEqual({
    kind: "downloading",
    progress: 0.5,
    verifying: true,
  });
  body.resolve();
  await ready.promise;
  expect(adapter.state(key)).toMatchObject({ kind: "local", lease: local });
  off();
  expect(released).toEqual([]);
  offGallery();
  expect(released).toEqual(["lease"]);

  const reopened = Promise.withResolvers<void>();
  const unmount = adapter.subscribe(target, () => {
    if (adapter.state(key).kind === "local") reopened.resolve();
  });
  await Promise.resolve();
  adapter.prepare(key);
  await reopened.promise;
  expect(requests).toBe(1);
  unmount();
});

test("cancel aborts the active native transfer and removes any late lease", async () => {
  const cancelled = Promise.withResolvers<void>();
  const started = Promise.withResolvers<AbortSignal>();
  const adapter = createAttachmentPresentation(
    {
      attachmentStatus: async () => false,
      openAttachment: async () => null,
      releaseAttachment: async () => {},
      downloadAttachment: async (_g, _m, _s, _i, _progress, signal) => {
        started.resolve(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    },
    () => true,
  );
  const unmount = adapter.subscribe(target, () => {
    if (adapter.state(key).kind === "cancelled") cancelled.resolve();
  });
  adapter.download(key);
  const signal = await started.promise;
  adapter.cancel(key);
  await cancelled.promise;
  expect(signal.aborted).toBe(true);
  expect(adapter.state(key).kind).toBe("cancelled");
  unmount();
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
