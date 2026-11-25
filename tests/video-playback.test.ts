import { expect, test } from "bun:test";
import type { VideoPlayer } from "expo-video";
import { createPlaybackOwnership } from "@/core/media/playback-ownership";
import type { MediaHandle } from "@/core/media/source";
import { createVideoController } from "@/core/video/controller";
import type { SubtitleInput } from "@/core/video/subtitles/tracks";
import type { VideoSource } from "@/core/video/types";

const clip = (id: string): VideoSource => ({
  kind: "local",
  id,
  title: id,
  file: { name: id + ".mp4", path: "/" + id, type: "video/mp4" },
});

test("an explicit Boop player request opens the internal decoder with an external default", async () => {
  const { video, actions } = fixture(async () => ({
    kind: "local",
    file: { name: "shared.mp4", path: "/shared", type: "video/mp4" },
    uri: "file:///shared",
    expiresAt: null,
    async release() {},
  }));
  video.preferences({ external: true });

  expect(await video.open(clip("shared"), { openInBoop: true })).toBe(true);
  expect(video.store.getState().current?.player).toBeDefined();
  expect(video.store.getState().preferences.external).toBe(true);
  expect(actions).toEqual(["load", "play"]);
  await video.close();
});

test("progressive playback revokes blocking reads before releasing the decoder and keeps exports closed", async () => {
  const events: string[] = [];
  const { video, actions } = fixture(
    async () => ({
      kind: "progressive",
      uri: "boop-media://test",
      sourceId: "stream",
      size: 300,
      mimeType: "video/mp4",
      expiresAt: null,
      async cancelReads() {
        events.push("read-cancelled");
      },
      async release() {
        events.push("file-unpinned");
      },
    }),
    events,
  );
  expect(await video.open(clip("stream"), { progressive: true })).toBe(true);
  const first = video.store.getState().current;
  expect(first).toMatchObject({ progressive: true, canExport: false });
  expect(await video.open(clip("stream"), { progressive: true })).toBe(true);
  expect(video.store.getState().current?.player).toBe(first?.player);
  expect(actions).toEqual(["load", "play"]);
  await video.close();
  expect(actions.slice(-3)).toEqual([
    "read-cancelled",
    "decoder closed",
    "file-unpinned",
  ]);
});

test("opening waits for co-selected subtitles before exposing or starting playback", async () => {
  const { video, actions } = fixture(async () => ({
    kind: "local",
    file: { name: "a", path: "/a", type: "video/mp4" },
    uri: "file:///a",
    expiresAt: null,
    async release() {},
  }));
  const loaderEntered = Promise.withResolvers<void>();
  const selected = Promise.withResolvers<SubtitleInput[]>();
  const opening = video.open(clip("a"), {
    relatedSubtitles() {
      loaderEntered.resolve();
      return selected.promise;
    },
  });
  await loaderEntered.promise;
  expect(video.store.getState().current?.player).toBeUndefined();
  expect(actions).toEqual(["load"]);
  selected.resolve([
    {
      name: "a.srt",
      bytes: new TextEncoder().encode(
        "1\n00:00:01,000 --> 00:00:04,000\nCaption",
      ),
    },
  ]);
  expect(await opening).toBe(true);
  expect(video.store.getState().current?.subtitles.tracks).toHaveLength(1);
  expect(actions).toEqual(["load", "play"]);
  await video.close();
});

test("protected videos never read co-selected subtitles, and a replaced session cannot import them", async () => {
  const { video } = fixture(async (source) => ({
    kind: "local",
    file: { name: source.title, path: "/video", type: "video/mp4" },
    uri: "file:///video",
    expiresAt: source.title === "protected" ? Date.now() + 30_000 : null,
    async release() {},
  }));
  let reads = 0;
  await video.open(clip("protected"), {
    async relatedSubtitles() {
      reads++;
      return [];
    },
  });
  expect(reads).toBe(0);
  const protectedPlayer = video.store.getState().current?.player;
  expect(protectedPlayer).toBeDefined();
  if (!protectedPlayer) throw new Error("Expected player");
  expect(video.subtitleImportSignal(protectedPlayer)).toBeUndefined();

  await video.open(clip("other"));
  const player = video.store.getState().current?.player;
  if (!player) throw new Error("Expected current player");
  const signal = video.subtitleImportSignal(player);
  expect(signal?.aborted).toBe(false);
  await video.close();
  expect(signal?.aborted).toBe(true);
  expect(
    video.addSubtitles(player, [
      {
        name: "other.srt",
        bytes: new TextEncoder().encode(
          "1\n00:00:01,000 --> 00:00:04,000\nLate",
        ),
      },
    ]),
  ).toBe(0);
});

function fixture(
  acquire: Parameters<typeof createVideoController>[0]["acquire"],
  actions: string[] = [],
) {
  const video = createVideoController({
    acquire,
    engine() {
      const player = {
        duration: 60,
        currentTime: 0,
        status: "readyToPlay",
        availableVideoTracks: [{}],
        addListener: () => ({ remove() {} }),
        play: () => {
          actions.push("play");
        },
        pause: () => {
          actions.push("pause");
        },
      } as unknown as VideoPlayer;
      return {
        player,
        async load() {
          actions.push("load");
        },
        stop() {
          actions.push("stop");
        },
        async close() {
          actions.push("decoder closed");
        },
      };
    },
    claim: () => true,
    release() {},
    allowed: () => true,
    async handoff() {},
    position: () => 12,
    genericTitle: () => "Video",
    checkpoint: (_id, time) => {
      actions.push("checkpoint " + time);
    },
    preferences: {
      external: false,
      pipMode: "inApp",
      advancedGestures: true,
      seekInterval: 10,
      rememberPosition: true,
      allowBackground: true,
    },
    savePreferences() {},
  });
  return { video, actions };
}

test("minimize and expand preserve the player and close the decoder before releasing the lease", async () => {
  const source = clip("a");
  const { video, actions } = fixture(async () => ({
    kind: "local",
    file: { name: "a", path: "/a", type: "video/mp4" },
    uri: "file:///a",
    expiresAt: null,
    async release() {
      actions.push("lease released");
    },
  }));
  expect(await video.open(source)).toBe(true);
  const player = video.store.getState().current?.player;
  expect(player?.currentTime).toBe(12);
  video.present("floating");
  expect(video.store.getState().current?.player).toBe(player);
  video.present("full");
  expect(video.store.getState().current?.player).toBe(player);
  await video.close();
  expect(actions).toEqual([
    "load",
    "play",
    "stop",
    "checkpoint 12",
    "decoder closed",
    "lease released",
  ]);
});

test("a late source is released without creating another decoder after a rapid switch", async () => {
  const slow = Promise.withResolvers<MediaHandle>();
  const started = Promise.withResolvers<void>();
  let abandoned = false;
  const { video, actions } = fixture(async (source) => {
    if (source.title === "a") {
      started.resolve();
      return slow.promise;
    }
    return {
      kind: "local",
      file: { name: "b", path: "/b", type: "video/mp4" },
      uri: "file:///b",
      expiresAt: null,
      async release() {},
    };
  });
  const first = video.open(clip("a"));
  await started.promise;
  expect(await video.open(clip("b"))).toBe(true);
  slow.resolve({
    kind: "local",
    file: { name: "a", path: "/a", type: "video/mp4" },
    uri: "file:///a",
    expiresAt: null,
    async release() {
      abandoned = true;
    },
  });
  expect(await first).toBe(false);
  expect(abandoned).toBe(true);
  expect(video.store.getState().current?.source.title).toBe("b");
  expect(actions).toEqual(["load", "play"]);
  await video.close();
});

test("App Lock retires native playback and restores the covered video at the same position after unlock", async () => {
  const { video, actions } = fixture(async () => ({
    kind: "local",
    file: { name: "a", path: "/a", type: "video/mp4" },
    uri: "file:///a",
    expiresAt: null,
    async release() {
      actions.push("lease released");
    },
  }));
  video.privacy({ active: true, locked: false, enabled: true });
  await video.open(clip("a"));
  const previous = video.store.getState().current?.player;
  if (!previous) throw new Error("Video did not open");
  previous.currentTime = 23;
  expect(video.store.getState().current?.allowPiP).toBe(false);
  await video.privacy({ active: false, locked: true, enabled: true });
  expect(video.store.getState().current?.player).toBeUndefined();
  expect(video.store.getState().current?.presentation).toBe("full");
  expect(actions.at(-1)).toBe("lease released");
  await video.privacy({ active: true, locked: true, enabled: true });
  expect(video.store.getState().current?.player).toBeUndefined();
  await video.privacy({ active: true, locked: false, enabled: true });
  expect(video.store.getState().current?.player).not.toBe(previous);
  expect(video.store.getState().current?.player?.currentTime).toBe(23);
  expect(actions.filter((action) => action === "play")).toEqual(["play"]);
  await video.drain();
});

test("floating in-app playback stays attached through system PiP and an early exit callback", async () => {
  const { video, actions } = fixture(async () => ({
    kind: "local",
    file: { name: "a", path: "/a", type: "video/mp4" },
    uri: "file:///a",
    expiresAt: null,
    async release() {},
  }));
  video.preferences({ pipMode: "system" });
  await video.open(clip("a"));
  const player = video.store.getState().current?.player;
  if (!player) throw new Error("Video did not open");
  video.present("floating");
  video.privacy({ active: false, locked: false, enabled: false });
  video.pictureInPicture(player, true);
  video.pictureInPicture(player, false);
  video.privacy({ active: true, locked: false, enabled: false });
  expect(video.store.getState().current?.player).toBe(player);
  expect(video.store.getState().current?.presentation).toBe("floating");
  expect(actions).not.toContain("pause");
  await video.drain();
});

test("in-app-only PiP pauses in the background and Off removes the floating player", async () => {
  const { video, actions } = fixture(async () => ({
    kind: "local",
    file: { name: "a", path: "/a", type: "video/mp4" },
    uri: "file:///a",
    expiresAt: null,
    async release() {},
  }));
  await video.open(clip("a"));
  video.present("floating");
  video.privacy({ active: false, locked: false, enabled: false });
  expect(actions.at(-1)).toBe("pause");
  video.privacy({ active: true, locked: false, enabled: false });
  video.preferences({ pipMode: "off" });
  expect(video.store.getState().current).toBeUndefined();
  await video.drain();
});

test("the latest explicit playback request wins, and call or recording interruptions never resume it", () => {
  const ownership = createPlaybackOwnership();
  const events: string[] = [];
  ownership.register("audio", () => {
    events.push("pause audio");
    ownership.release("audio");
  });
  ownership.register("video", () => {
    events.push("stop video");
    ownership.release("video");
  });
  expect(ownership.claim("audio")).toBe(true);
  expect(ownership.claim("video")).toBe(true);
  ownership.interrupt(true);
  expect(ownership.claim("audio")).toBe(false);
  ownership.interrupt(false);
  expect(events).toEqual(["pause audio", "stop video"]);
  expect(ownership.claim("audio")).toBe(true);
});

test("round notes share playback ownership and a recycled row cannot release the next note", () => {
  const ownership = createPlaybackOwnership();
  const stops: string[] = [];
  ownership.register("audio", () => stops.push("audio"));
  ownership.register("video", () => stops.push("video"));
  ownership.claim("audio");
  const releaseFirst = ownership.claimRoundNote(() => stops.push("first"));
  const releaseSecond = ownership.claimRoundNote(() => stops.push("second"));
  if (!releaseFirst || !releaseSecond) throw new Error("Round claim denied");
  releaseFirst();
  ownership.claim("video");
  expect(stops).toEqual(["audio", "second"]);

  const releaseThird = ownership.claimRoundNote(() => stops.push("third"));
  if (!releaseThird) throw new Error("Round claim denied");
  releaseSecond();
  ownership.interrupt(true);
  expect(ownership.claimRoundNote(() => stops.push("blocked"))).toBe(false);
  ownership.interrupt(false);
  releaseThird();
  expect(stops).toEqual(["audio", "second", "video", "third"]);
});
