import { describe, expect, test } from "bun:test";
import { decodeSubtitle } from "@/core/video/subtitles/encoding";
import { nativeSubtitle } from "@/core/video/subtitles/native-vtt";
import { parseSubtitle } from "@/core/video/subtitles/parse";
import { bindSubtitles } from "@/core/video/subtitles/session";
import { indexSubtitles } from "@/core/video/subtitles/timeline";
import {
  loadSubtitle,
  relatedSubtitle,
  type SubtitleState,
} from "@/core/video/subtitles/tracks";
import {
  defaultCaptionAppearance,
  subtitleByteLimit,
} from "@/core/video/subtitles/types";
import {
  notifySubtitleSeek,
  observeSubtitles,
} from "@/core/video/subtitles/sync";
import type { VideoPlayer } from "expo-video";

const encode = (value: string) => new TextEncoder().encode(value);
const source = (name: string) =>
  Bun.file(new URL("fixtures/subtitles/" + name, import.meta.url)).bytes();
const line = (cue: { runs: readonly { text: string }[] }) =>
  cue.runs.map((run) => run.text).join("");

describe("subtitle files", () => {
  test("parses SRT formatting, text entities and overlapping runs", async () => {
    const sub = parseSubtitle(await source("plain.srt"), "plain.srt");
    expect(sub?.format).toBe("srt");
    const timeline = indexSubtitles(sub?.cues ?? []);
    expect(timeline.active(61.1).map(line)).toEqual([
      "Hello & goodbye",
      "שורה שנייה",
    ]);
    expect(timeline.active(62).map(line)).toEqual(["שורה שנייה"]);
    expect(timeline.cues[0].runs[0].style?.color).toBe("#ffffff");
    expect(timeline.cues[1].runs[0].style?.italic).toBe(true);
  });

  test("parses VTT regions, Arabic and Hebrew, nested styles, voice, ruby and cue boundaries", async () => {
    const sub = parseSubtitle(await source("structured.vtt"), "structured.vtt");
    const timeline = indexSubtitles(sub?.cues ?? []);
    const [first, second] = timeline.active(2.1);
    expect(sub?.format).toBe("vtt");
    expect(first.layout).toEqual({ x: 35, y: 75, width: 60, align: "start" });
    expect(first.runs[0]).toMatchObject({
      text: "שלום",
      speaker: "Narrator",
      style: { color: "yellow", background: "black", bold: true },
    });
    expect(
      first.runs.find((run) => run.text.includes("مرحبا"))?.style,
    ).toMatchObject({ italic: true, underline: true });
    expect(first.runs.find((run) => run.text === "漢")?.ruby).toBe("かん");
    expect(line(first)).toContain("1 < 2 & 3 > 2");
    expect(second.runs[1]).toMatchObject({ text: "B", from: 2.2 });
    expect(timeline.next(2.1)).toBe(2.2);
    expect(timeline.active(5)).toEqual([]);
  });

  test("preserves angle brackets, malformed tokens and decoded entities as literal text", async () => {
    const sub = parseSubtitle(await source("structured.vtt"), "structured.vtt");
    expect(line(sub!.cues[2])).toBe(
      '<i>literal</i> &lt;\nש ש &#x05E9; &#0;\n<custom>label</custom>\n<cus<i>tom>\n<i\n<img src="https://example.invalid/asset">',
    );
    expect(sub?.cues[2].runs.some((run) => run.style)).toBe(false);
  });

  test("supports ASS dialogue styles, position, karaoke and text after a drawing", async () => {
    const sub = parseSubtitle(await source("advanced.ass"), "advanced.ass");
    expect(sub?.format).toBe("ass");
    const [first, second, third] = sub?.cues ?? [];
    expect(first.layout).toEqual({ x: 25, y: 25, align: "left" });
    expect(line(first)).toBe("שלום\nالعربية, welcome");
    expect(first.runs[1].style).toMatchObject({
      bold: true,
      italic: true,
      color: "#ff3300",
      background: "#000000",
    });
    expect(second.runs.map((run) => run.from)).toEqual([2, 2.25]);
    expect(line(third)).toBe("text");
  });

  test("supports SSA legacy color and alignment values", async () => {
    const sub = parseSubtitle(await source("legacy.ssa"), "local.ssa");
    expect(sub?.format).toBe("ssa");
    const cue = sub!.cues[0];
    expect(line(cue)).toBe("старый файл");
    expect(cue.layout).toEqual({ x: undefined, y: 8, align: "center" });
    expect(cue.runs[0].style).toMatchObject({ color: "#0000ff", italic: true });
  });

  test("decodes UTF BOMs and legacy Hebrew, Arabic, Cyrillic and Western code pages", () => {
    expect(decodeSubtitle(Uint8Array.of(0xef, 0xbb, 0xbf, 0x41), "auto")).toBe(
      "A",
    );
    expect(decodeSubtitle(Uint8Array.of(0xff, 0xfe, 0xe9, 0x05), "auto")).toBe(
      "ש",
    );
    expect(decodeSubtitle(Uint8Array.of(0xfe, 0xff, 0x05, 0xe9), "auto")).toBe(
      "ש",
    );
    expect(
      decodeSubtitle(
        Uint8Array.of(0xf9, 0xc8, 0xec, 0xe5, 0xed),
        "windows-1255",
      ),
    ).toBe("שָלום");
    expect(
      decodeSubtitle(Uint8Array.of(0xd3, 0xe1, 0xc7, 0xe3), "windows-1256"),
    ).toBe("سلام");
    expect(
      decodeSubtitle(
        Uint8Array.of(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2),
        "windows-1251",
      ),
    ).toBe("Привет");
    expect(decodeSubtitle(Uint8Array.of(0x80, 0x20, 0xe9), "auto")).toBe("€ é");
  });

  test("ignores malformed times, reversals, unknown formats and oversized input", () => {
    const bytes = encode(
      "WEBVTT\n\n00:61.000 --> 00:02.000\nbad\n\n00:02.000 --> 00:01.000\nbad",
    );
    expect(parseSubtitle(bytes, "bad.vtt")).toBeUndefined();
    expect(parseSubtitle(encode("text"), "bad.pgs")).toBeUndefined();
    expect(
      parseSubtitle(new Uint8Array(subtitleByteLimit + 1), "huge.srt"),
    ).toBeUndefined();
  });

  test("keeps nested and adversarial formatting bounded", () => {
    const malicious =
      "<i>".repeat(300) + "text" + "</i>".repeat(100) + "&".repeat(300);
    const sub = parseSubtitle(
      encode("1\n00:01.000 --> 00:02.000\n" + malicious),
      "a.srt",
    );
    expect(sub?.cues[0].runs.length).toBeLessThanOrEqual(128);
    expect(line(sub!.cues[0])).toContain("text");
  });

  test("serializes only safe text and generated tags to native WebVTT", () => {
    const track = loadSubtitle(
      {
        name: "x.srt",
        bytes: encode(
          "1\n00:00:02,000 --> 00:00:04,000\n<b>Hi</b> &lt;img src=x&gt;",
        ),
      },
      1,
    );
    expect(nativeSubtitle(track!, -0.5)).toBe(
      "WEBVTT\n\n00:00:01.500 --> 00:00:03.500\n<b>Hi</b> &lt;img src=x&gt;\n",
    );
  });

  test("matches only names from the supplied related scope", () => {
    expect(relatedSubtitle("电影.MKV", "电影.srt")).toEqual({});
    expect(relatedSubtitle("Movie.mkv", "movie.pt-BR.ass")).toEqual({
      language: "pt-br",
    });
    expect(relatedSubtitle("Movie.mkv", "Movie.extras.srt")).toBeUndefined();
    expect(relatedSubtitle("Movie.mkv", "Movies.en.srt")).toBeUndefined();
  });
});

test("indexes thousands of cues including overlaps and bounded visible cues", () => {
  const input = Array.from({ length: 10_000 }, (_, n) => ({
    start: n / 2,
    end: n / 2 + 100,
    runs: [{ text: String(n) }],
  }));
  const timeline = indexSubtitles(input);
  expect(timeline.active(20).map(line)).toEqual([
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
  ]);
  expect(timeline.active(5100)).toEqual([]);
  expect(timeline.next(20)).toBe(20.5);
  expect(timeline.next(5100)).toBeUndefined();
});

function fixturePlayer() {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const embedded = {
    id: "embedded",
    language: "en",
    label: "English",
    name: "English",
  };
  const player = {
    currentTime: 0,
    playing: false,
    playbackRate: 1,
    status: "readyToPlay",
    loop: false,
    subtitleTrack: null,
    availableSubtitleTracks: [embedded],
    addListener(
      name: string,
      action: (event: Record<string, unknown>) => void,
    ) {
      listeners.set(name, action);
      return { remove: () => listeners.delete(name) };
    },
  };
  return {
    player: player as unknown as VideoPlayer,
    embedded,
    emit: (name: string, event = {}) => listeners.get(name)?.(event),
    count: () => listeners.size,
  };
}

test("fallback follows clock seeks, buffering, playback end, restart and offsets", async () => {
  const { player, emit, count } = fixturePlayer();
  const timeline = indexSubtitles([
    { start: 1, end: 2, runs: [{ text: "cue" }] },
  ]);
  const frames: string[][] = [];
  const stop = observeSubtitles(player, timeline, 0.25, (frame) =>
    frames.push(frame.cues.map(line)),
  );
  expect(frames.at(-1)).toEqual([]);
  player.currentTime = 1.25;
  notifySubtitleSeek(player);
  expect(frames.at(-1)).toEqual(["cue"]);
  emit("statusChange");
  emit("playbackRateChange");
  expect(frames.length).toBe(2);
  emit("playToEnd");
  expect(frames.at(-1)).toEqual([]);
  emit("playingChange", { isPlaying: true });
  expect(frames.at(-1)).toEqual(["cue"]);
  player.currentTime = 2.25;
  emit("timeUpdate");
  expect(frames.at(-1)).toEqual([]);
  stop();
  expect(count()).toBe(0);
});

test("external import, encoding, offset, selection and retirement are session scoped", async () => {
  const { player, embedded } = fixturePlayer();
  const changes: SubtitleState[] = [];
  const offsets: number[] = [];
  let active = true;
  const subtitles = bindSubtitles(player, {
    active: () => active,
    allowExternal: true,
    initialOffset: 0,
    saveOffset: (value) => offsets.push(value),
    publish: (state) => changes.push(state),
    appearance: () => defaultCaptionAppearance,
  });
  expect(
    subtitles.add([
      { name: "plain.srt", bytes: await source("plain.srt") },
      { name: "extra.ass", bytes: await source("advanced.ass") },
    ]),
  ).toBe(2);
  const first = subtitles.state.tracks[0];
  expect(subtitles.state.selection).toEqual({ kind: "external", id: first.id });
  expect(subtitles.state.rendering).toBe("fallback");
  expect(subtitles.encoding(first.id, "windows-1251")).toBe(true);
  subtitles.offset(-0.15);
  expect(offsets).toEqual([-0.15]);
  subtitles.select({ kind: "embedded", track: embedded });
  await Bun.sleep(0);
  expect(player.subtitleTrack).toEqual(embedded);
  subtitles.remove(first.id);
  expect(subtitles.state.tracks).toHaveLength(1);
  active = false;
  subtitles.close();
  expect(
    subtitles.add([{ name: "plain.srt", bytes: await source("plain.srt") }]),
  ).toBe(0);
  expect(subtitles.state.tracks).toEqual([]);
});

test("a delayed native subtitle attachment cannot override a newer embedded selection", async () => {
  const { player, embedded } = fixturePlayer();
  const activeAttachment = Promise.withResolvers<void>();
  const attached = Promise.withResolvers<void>();
  const requests: (string | null)[] = [];
  player.setExternalSubtitle = async (vtt) => {
    requests.push(vtt);
    if (vtt) {
      attached.resolve();
      await activeAttachment.promise;
    }
  };
  const subtitles = bindSubtitles(player, {
    active: () => true,
    allowExternal: true,
    initialOffset: 0,
    saveOffset() {},
    publish() {},
    appearance: () => defaultCaptionAppearance,
  });
  subtitles.add([
    {
      name: "track.srt",
      bytes: encode("1\n00:00:01,000 --> 00:00:05,000\nNative"),
    },
  ]);
  await attached.promise;
  subtitles.select({ kind: "embedded", track: embedded });
  activeAttachment.resolve();
  await Bun.sleep(0);
  expect(requests).toEqual([
    "WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nNative\n",
    null,
  ]);
  expect(player.subtitleTrack).toEqual(embedded);
  expect(subtitles.state.selection).toEqual({
    kind: "embedded",
    track: embedded,
  });
});
