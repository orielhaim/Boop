import { expect, test } from "bun:test";
import type { VideoPlayer } from "expo-video";
import { createPlaybackOwnership } from "@/core/media/playback-ownership";
import type { MediaHandle } from "@/core/media/source";
import { createVideoController } from "@/core/video/controller";
import { readSubtitles, subtitleAt } from "@/core/video/subtitles";
import type { VideoSource } from "@/core/video/types";

const clip = (id: string): VideoSource => ({
  kind: "local",
  id,
  title: id,
  file: { name: id + ".mp4", path: "/" + id, type: "video/mp4" },
});

function fixture(
  acquire: Parameters<typeof createVideoController>[0]["acquire"],
) {
  const actions: string[] = [];
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

test("local captions parse VTT and SRT timecodes, preserve multiline Hebrew and ignore markup", () => {
  const utf8 = (text: string) => new TextEncoder().encode(text);
  const webvtt = readSubtitles(
    utf8(
      "WEBVTT\n\n00:01.010 --> 00:02.000 align:center\nשלום\n<i>שורה שנייה</i>\n",
    ),
  );
  expect(subtitleAt(webvtt, 1.5)).toBe("שלום\nשורה שנייה");
  expect(subtitleAt(webvtt, 2)).toBeUndefined();
  const srt = readSubtitles(
    utf8(
      '1\r\n01:00:00,100 --> 01:00:02,000\r\n<font color="#ffffff">Hello</font> &amp; goodbye\r\n',
    ),
  );
  expect(subtitleAt(srt, 3601)).toBe("Hello & goodbye");
});

test("local captions decode entities once and preserve unknown or malformed markup as text", () => {
  const cues = readSubtitles(
    new TextEncoder().encode(
      "WEBVTT\n\n00:01.000 --> 00:04.000\n" +
        "<v Narrator><c.emphasis><b>שלום</b></c></v><00:02.000>\n" +
        "1 < 2 &amp; 3 > 2\n" +
        "&lt;i&gt;literal&lt;/i&gt; &amp;lt;\n" +
        "<custom>label</custom>\n" +
        "<cus<i>tom>\n" +
        "<i",
    ),
  );
  expect(subtitleAt(cues, 2)).toBe(
    "שלום\n1 < 2 & 3 > 2\n<i>literal</i> &lt;\n" +
      "<custom>label</custom>\n<cus<i>tom>\n<i",
  );
});
