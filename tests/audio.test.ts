import { expect, test } from "bun:test";
import {
  createAudioController,
  playerPlayback,
  type AudioHandle,
  type Commands,
} from "../src/core/audio/controller";
import {
  opensExternally,
  showMiniPlayer,
  trackId,
  type SavedPlayback,
  type Track,
} from "../src/core/audio/types";
import { audioPersistence } from "../src/db/audio";
import { createDownloadManager } from "../src/core/downloads/manager";
import { waitForDownload } from "../src/core/audio/download";
import { waitForAudioAuthority } from "../src/core/audio/authorization";
import type { DownloadJob, MarmotDownload } from "../src/core/downloads/types";

const attachment = (
  group: string,
  name: string,
  voice = false,
  expiresAt: number | null = null,
): Track => ({
  kind: "attachment",
  source: {
    kind: "marmot",
    target: [group, name, "source", 0],
    sender: "sender",
    name,
    type: "audio/mp4",
    total: 20,
    expiresAt,
  },
  title: name,
  voice,
  duration: 60,
});
const song = attachment("music", "First song");
const second = attachment("music", "Second song");
const third = attachment("music", "Third song");
const voice = attachment("chat-a", "Voice note", true);
const otherVoice = attachment("chat-b", "Another voice note", true);

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("audio waits for conversation authority and abandons the wait when playback is cancelled", async () => {
  let authorityReady = false;
  const listeners = new Set<() => void>();
  const window = {
    getState: () => ({
      status: "ready" as const,
      snapshot: { authorityReady },
    }),
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
  };
  const signal = new AbortController();
  const waiting = waitForAudioAuthority(window, signal.signal);
  expect(listeners.size).toBe(1);
  authorityReady = true;
  for (const notify of listeners) notify();
  await waiting;
  expect(listeners.size).toBe(0);

  authorityReady = false;
  const cancelled = waitForAudioAuthority(window, signal.signal);
  signal.abort(new Error("Playback cancelled"));
  await expect(cancelled).rejects.toThrow("Playback cancelled");
  expect(listeners.size).toBe(0);
});

function fixture(
  saved?: SavedPlayback,
  acquire?: (track: Track, signal: AbortSignal) => Promise<AudioHandle>,
  ready?: (uri: string, signal: AbortSignal) => Promise<void>,
) {
  const events: string[] = [];
  const denied = new Set<string>();
  let state = saved;
  let native: Commands | undefined;
  let update:
    ((position: number, playing: boolean, ended: boolean) => void) | undefined;
  const audio = createAudioController({
    saved,
    save: (value) => {
      state = structuredClone(value);
    },
    preferences: { external: false, voiceSpeed: 1.2 },
    savePreferences: ({ voiceSpeed }) =>
      events.push(`saved-rate:${voiceSpeed}`),
    async acquire(track, { signal }) {
      events.push(`acquire:${track.title}`);
      if (acquire) return acquire(track, signal);
      return {
        uri: `file:///temp/${track.title}`,
        async release() {
          events.push(`release:${track.title}`);
        },
      };
    },
    async setup() {
      events.push("setup");
    },
    engine(uri, commands) {
      let position = 0;
      let isPlaying = false;
      events.push(`engine:${uri}`);
      return {
        async ready(signal) {
          await ready?.(uri, signal);
        },
        snapshot: () => ({ position, playing: isPlaying }),
        play() {
          native = commands;
          isPlaying = true;
          update = (pos, playing, ended) => {
            position = pos;
            isPlaying = playing;
            commands.status({ position: pos, duration: 60, playing, ended });
          };
          events.push(`play:${uri}`);
          commands.status({ playing: true, position, duration: 60 });
        },
        pause() {
          isPlaying = false;
          events.push(`pause:${uri}`);
          commands.status({ playing: false, position, duration: 60 });
        },
        async seek(value) {
          position = value;
          events.push(`seek:${value}`);
        },
        speed(value) {
          events.push(`rate:${value}`);
        },
        controls(metadata) {
          events.push(`media:${metadata?.title}`);
        },
        close() {
          events.push("close");
        },
      };
    },
    allowed: (track) => !denied.has(trackId(track)),
    listened: (track) => events.push(`listened:${track.title}`),
    genericTitle: () => "Boop audio",
  });
  return {
    audio,
    events,
    denied,
    state: () => state,
    native: () => native,
    status(pos: number, playing: boolean, ended = false) {
      update?.(pos, playing, ended);
    },
  };
}

test("voice playback and pause stay synchronized across originating and unrelated routes", async () => {
  const { audio, events, status } = fixture();
  await audio.play(voice);
  status(19, true);
  const get = () => audio.store.getState().current;
  expect(showMiniPlayer(get()?.track, "chat-a")).toBe(false);
  expect(showMiniPlayer(get()?.track, "chat-b")).toBe(true);
  expect(showMiniPlayer(get()?.track)).toBe(true);
  audio.toggle();
  expect(showMiniPlayer(get()?.track, "chat-a")).toBe(false);
  expect(get()?.phase).toBe("paused");
  expect(get()?.position).toBe(19);
  expect(events.filter((event) => event.startsWith("engine:"))).toEqual([
    "engine:file:///temp/Voice note",
  ]);
  expect(events).toContain("listened:Voice note");
  audio.speed(1.7);
  expect(events).toContain("saved-rate:1.7");
  await audio.close();
  expect(events).toContain("release:Voice note");
});

test("rapid repeated taps share one request and switching voice notes releases the old lease", async () => {
  const { audio, events } = fixture();
  await Promise.all([audio.play(voice), audio.play(voice), audio.play(voice)]);
  await audio.play(otherVoice);
  expect(audio.store.getState().current?.track.title).toBe(
    "Another voice note",
  );
  expect(events.filter((event) => event === "acquire:Voice note")).toHaveLength(
    1,
  );
  expect(events.filter((event) => event === "release:Voice note")).toHaveLength(
    1,
  );
  await audio.close();
  expect(
    events.filter((event) => event === "release:Another voice note"),
  ).toHaveLength(1);
});

test("play now preserves Up Next, and queue edits leave native playback alone", async () => {
  const { audio, events, native, status } = fixture();
  await audio.play(song);
  expect(audio.enqueue(second)).toBe(true);
  expect(audio.enqueue(second)).toBe(false);
  audio.enqueue(third, true);
  status(16, true);
  audio.reorder(trackId(third), 1);
  expect(audio.store.getState().upcoming.map((track) => track.title)).toEqual([
    "Second song",
    "Third song",
  ]);
  expect(audio.store.getState().current?.position).toBe(16);
  expect(events.filter((event) => event.startsWith("engine:"))).toHaveLength(1);
  await audio.play(otherVoice);
  expect(audio.store.getState().upcoming).toHaveLength(2);
  native()?.next();
  await tick();
  expect(audio.store.getState().current?.track.title).toBe("Second song");
  audio.remove(trackId(third));
  expect(audio.store.getState().upcoming).toEqual([]);
  native()?.stop();
  expect(audio.store.getState().current).toBeUndefined();
});

test("music resumes at the interrupted position only after a naturally finished voice note", async () => {
  const { audio, status, events } = fixture();
  await audio.play(song);
  status(23, true);
  await audio.play(voice);
  status(60, false, true);
  await tick();
  expect(audio.store.getState().current?.track.title).toBe("First song");
  expect(audio.store.getState().current?.position).toBe(23);
  expect(
    events.filter((event) => event === "engine:file:///temp/First song"),
  ).toHaveLength(1);
  expect(events).toContain("pause:file:///temp/First song");
  await audio.play(voice);
  audio.call(true);
  audio.call(false);
  expect(audio.store.getState().current?.phase).toBe("paused");
  audio.stop();
  expect(audio.store.getState().current).toBeUndefined();
  expect(audio.store.getState().upcoming[0]?.title).toBe("First song");
});

test("music keeps playing while a voice attachment is acquired and resumes from the handoff", async () => {
  const pending = Promise.withResolvers<AudioHandle>();
  const buffered = Promise.withResolvers<void>();
  const { audio, events, status } = fixture(
    undefined,
    async (track) =>
      track.voice
        ? pending.promise
        : { uri: "file:///music", async release() {} },
    (uri) => (uri === "file:///voice" ? buffered.promise : Promise.resolve()),
  );
  await audio.play(song);
  audio.enqueue(second);
  status(23, true);
  const interlude = audio.play(voice);
  expect(audio.store.getState().current).toMatchObject({
    track: song,
    phase: "playing",
    position: 23,
  });
  pending.resolve({ uri: "file:///voice", async release() {} });
  await tick();
  expect(events).toContain("engine:file:///voice");
  expect(events).not.toContain("pause:file:///music");
  expect(events).not.toContain("play:file:///voice");
  expect(audio.store.getState().preparingVoice).toBe(trackId(voice));
  status(30, true);
  buffered.resolve();
  expect(await interlude).toBe(true);
  expect(events.filter((event) => /^(pause|play):/.test(event))).toEqual([
    "play:file:///music",
    "pause:file:///music",
    "play:file:///voice",
  ]);
  status(60, false, true);
  await tick();
  expect(audio.store.getState().current).toMatchObject({
    track: song,
    phase: "playing",
    position: 30,
  });
  expect(audio.store.getState().upcoming).toEqual([second]);
  expect(
    events.filter((event) => event === "engine:file:///music"),
  ).toHaveLength(1);
  await audio.close();
});

test("cancelling or failing voice preparation never interrupts music", async () => {
  const pending = Promise.withResolvers<AudioHandle>();
  let attempts = 0;
  let releases = 0;
  const { audio, events, status } = fixture(undefined, async (track) => {
    if (!track.voice) return { uri: "file:///music", async release() {} };
    if (++attempts === 1) return pending.promise;
    throw new Error("AudioUnavailable");
  });
  await audio.play(song);
  status(12, true);
  const cancelled = audio.play(voice);
  expect(audio.cancelVoice(trackId(voice))).toBe(true);
  pending.resolve({
    uri: "file:///voice",
    async release() {
      releases++;
    },
  });
  expect(await cancelled).toBe(false);
  await expect(audio.play(voice)).rejects.toThrow("AudioUnavailable");
  expect(audio.store.getState()).toMatchObject({
    current: { track: song, phase: "playing", position: 12 },
    preparingVoice: undefined,
  });
  expect(events).not.toContain("pause:file:///music");
  expect(releases).toBe(1);
  await audio.close();
});

test("music paused while the voice note prepares stays paused after it ends", async () => {
  const buffered = Promise.withResolvers<void>();
  const { audio, status } = fixture(undefined, undefined, (uri) =>
    uri.endsWith("Voice note") ? buffered.promise : Promise.resolve(),
  );
  await audio.play(song);
  status(16, true);
  const interlude = audio.play(voice);
  audio.toggle();
  buffered.resolve();
  expect(await interlude).toBe(true);
  status(60, false, true);
  expect(audio.store.getState().current).toMatchObject({
    track: song,
    phase: "paused",
    position: 16,
  });
  await audio.close();
});

test("the player keeps the paused song visible and Play ends the voice note", async () => {
  const { audio, events, native, status } = fixture();
  const state = audio.store.getState;
  await audio.play(song);
  audio.enqueue(second);
  status(23, true);
  await audio.play(voice);
  const voiceCommands = native();
  status(3, true);
  expect(state().current).toMatchObject({ track: voice, position: 3 });
  expect(playerPlayback(state())).toMatchObject({
    track: song,
    phase: "paused",
    position: 23,
  });
  expect(showMiniPlayer(playerPlayback(state())?.track, "chat-a")).toBe(true);

  await audio.player.seek(30);
  audio.player.speed(1.5);
  expect(state().current?.position).toBe(3);
  expect(state().speed).toBe(1.2);
  audio.player.toggle();
  voiceCommands?.status({
    duration: 60,
    position: 60,
    playing: false,
    ended: true,
  });
  expect(state()).toMatchObject({
    current: { track: song, position: 30, phase: "playing" },
    pausedMusic: undefined,
    speed: 1.5,
    upcoming: [second],
  });
  expect(events).toContain("release:Voice note");
  expect(
    events.filter((event) => event === "engine:file:///temp/First song"),
  ).toHaveLength(1);
  await audio.close();
});

test("dismissing the paused song leaves the voice note playing", async () => {
  const { audio, status } = fixture();
  await audio.play(song);
  await audio.play(voice);
  audio.player.stop();
  expect(playerPlayback(audio.store.getState())).toMatchObject({
    track: voice,
    phase: "playing",
  });
  status(60, false, true);
  expect(audio.store.getState().current).toBeUndefined();
  await audio.close();
});

test("a voice request keeps preparing when the music queue advances naturally", async () => {
  const buffered = Promise.withResolvers<void>();
  const { audio, status } = fixture(undefined, undefined, (uri) =>
    uri.endsWith("Voice note") ? buffered.promise : Promise.resolve(),
  );
  await audio.play(song);
  audio.enqueue(second);
  const interlude = audio.play(voice);
  status(60, false, true);
  await tick();
  expect(audio.store.getState().current?.track).toEqual(second);
  status(5, true);
  buffered.resolve();
  expect(await interlude).toBe(true);
  status(60, false, true);
  expect(audio.store.getState().current).toMatchObject({
    track: second,
    position: 5,
    phase: "playing",
  });
  await audio.close();
});

test("a call cancels a buffered voice request and prevents it from playing after the call", async () => {
  const buffered = Promise.withResolvers<void>();
  const { audio, events } = fixture(undefined, undefined, (uri) =>
    uri.endsWith("Voice note") ? buffered.promise : Promise.resolve(),
  );
  await audio.play(song);
  const interlude = audio.play(voice);
  await tick();
  expect(events).toContain("engine:file:///temp/Voice note");
  audio.call(true);
  audio.call(false);
  buffered.resolve();
  expect(await interlude).toBe(false);
  expect(events).not.toContain("play:file:///temp/Voice note");
  expect(audio.store.getState()).toMatchObject({
    current: { track: song, phase: "paused" },
    preparingVoice: undefined,
  });
  await audio.close();
});

test("consecutive voice notes leave the music queue in order and resume its current track", async () => {
  const { audio, status } = fixture();
  const get = audio.store.getState;
  await audio.play(song);
  audio.enqueue(second);
  audio.enqueue(third);
  status(23, true);

  await audio.play(voice);
  await audio.play(otherVoice);
  expect(get().current).toMatchObject({ track: otherVoice, phase: "playing" });
  expect(get().upcoming).toEqual([second, third]);

  status(60, false, true);
  await tick();
  expect(get().current).toMatchObject({
    track: song,
    phase: "playing",
    position: 23,
  });
  expect(get().upcoming).toEqual([second, third]);
  expect(get().history).toEqual([]);

  status(60, false, true);
  await tick();
  expect(get().current).toMatchObject({ track: second, phase: "playing" });
  expect(get().upcoming).toEqual([third]);
});

test("a standalone voice note does not drain Up Next; an explicitly queued voice note does", async () => {
  const { audio, status } = fixture();
  audio.enqueue(second);
  await audio.play(voice);
  status(60, false, true);
  expect(audio.store.getState().current).toBeUndefined();
  expect(audio.store.getState().upcoming[0]?.title).toBe("Second song");
  audio.enqueue(voice, true);
  await audio.next();
  status(60, false, true);
  await tick();
  expect(audio.store.getState().current?.track.title).toBe("Second song");
});

test("a restored standalone voice note leaves Up Next alone", async () => {
  const first = fixture();
  first.audio.enqueue(second);
  await first.audio.play(voice);
  const restored = fixture(first.state());
  expect(restored.audio.store.getState().current?.phase).toBe("restored");
  await restored.audio.play(voice);
  restored.status(60, false, true);
  expect(restored.audio.store.getState().current).toBeUndefined();
  expect(restored.audio.store.getState().upcoming).toEqual([second]);
});

test("a call or recorder blocks remote resumption and a late decrypted lease is released", async () => {
  const { promise, resolve } = Promise.withResolvers<AudioHandle>();
  let releases = 0;
  const { audio, native } = fixture(undefined, () => promise);
  const playing = audio.play(voice);
  audio.call(true);
  resolve({
    uri: "file:///private",
    async release() {
      releases++;
    },
  });
  expect(await playing).toBe(false);
  expect(native()).toBeUndefined();
  expect(releases).toBe(1);
  audio.call(false);
  audio.recording(true);
  expect(await audio.play(voice)).toBe(false);
  audio.recording(false);
  expect(audio.store.getState().current?.phase).toBe("paused");
});

test("lock mode redacts native metadata and teardown preserves a silent checkpoint", async () => {
  const { audio, status, events, state } = fixture();
  audio.privacy({ locked: false, enabled: true });
  await audio.play(voice);
  status(15, true);
  expect(events).toContain("media:Boop audio");
  expect(events).not.toContain("media:Voice note");
  audio.privacy({ locked: true, enabled: true });
  expect(audio.store.getState().current?.phase).toBe("paused");
  await audio.close();
  const restored = fixture(state());
  expect(restored.audio.store.getState().current?.phase).toBe("restored");
  expect(restored.audio.store.getState().current?.position).toBe(15);
  expect(restored.events).toEqual([]);
});

test("restored tracks expire, and authorization is rechecked before acquisition", async () => {
  const expired = attachment("chat", "Expired", true, Date.now() - 1);
  const { audio, denied, events } = fixture({
    current: { track: voice, position: 10 },
    upcoming: [expired, second, third],
    history: [],
    repeat: "off",
    shuffle: false,
  });
  denied.add(trackId(voice));
  denied.add(trackId(second));
  audio.revalidate();
  expect(audio.store.getState().current).toBeUndefined();
  expect(audio.store.getState().upcoming.map((track) => track.title)).toEqual([
    "Third song",
  ]);
  expect(await audio.play(expired)).toBe(false);
  expect(events).toEqual([]);
});

test("an encrypted playback checkpoint round-trips in queue order and rejects another identity", async () => {
  const values = new Map<string, string>();
  const key = new Uint8Array(32).fill(5);
  const store = (account: string, secret = key) =>
    audioPersistence({
      account,
      key: secret,
      random: (size) => crypto.getRandomValues(new Uint8Array(size)),
      read: (id) => values.get(id) ?? null,
      write: (id, value) => values.set(id, value),
    });
  const { audio, state } = fixture();
  await audio.play(song);
  audio.enqueue(second);
  audio.enqueue(third, true);
  const checkpoint = state();
  if (!checkpoint) throw new Error("Expected checkpoint");
  store("first").save(checkpoint);
  expect(
    store("first")
      .load()
      ?.upcoming.map((item) => item.title),
  ).toEqual(["Third song", "Second song"]);
  expect(store("second").load()).toBeUndefined();
  expect(store("first", new Uint8Array(32).fill(6)).load()).toBeUndefined();
  expect(values.get("audio.queue")).not.toContain("Second song");
  await audio.close();
});

test("ordinary audio honors the opening preference while voice remains internal", () => {
  expect(opensExternally(song, false)).toBe(false);
  expect(opensExternally(song, true)).toBe(true);
  expect(opensExternally(song, true, "internal")).toBe(false);
  expect(opensExternally(voice, true, "external")).toBe(false);
});

test("a playback request waits on PR #5's transfer and stops waiting when the transfer is cancelled", async () => {
  const rows = new Map<string, DownloadJob>();
  let transferred = 0;
  const releases: Array<() => void> = [];
  const downloads = createDownloadManager({
    eligible: () => true,
    authorized: () => true,
    store: {
      load: () => [...rows.values()],
      save: (jobs) => {
        for (const job of jobs) rows.set(job.id, job);
      },
      remove: (id) => {
        rows.delete(id);
      },
      clear: () => rows.clear(),
    },
    transport: {
      async status() {
        return "not_requested";
      },
      async control() {},
      async transfer(_source, _progress, signal) {
        transferred++;
        return new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("cancelled"), {
            once: true,
          });
          releases.push(() => resolve("ready"));
        });
      },
    },
  });
  const stop = downloads.start();
  downloads.network(true, false);
  await downloads.reconcile();
  const source = (track: Track): MarmotDownload => {
    if (track.kind !== "attachment" || track.source.kind !== "marmot")
      throw new Error("Expected attachment");
    return track.source;
  };
  const { audio, events } = fixture(undefined, async (track, signal) => {
    downloads.enqueue(source(track));
    await waitForDownload(downloads, source(track), signal);
    return { uri: "file:///temporary", async release() {} };
  });
  const request = audio.play(song);
  await tick();
  expect(transferred).toBe(1);
  expect(events).not.toContain("engine:file:///temporary");
  releases[0]?.();
  expect(await request).toBe(true);
  const pending = audio.play(second);
  await tick();
  await downloads.cancel(trackId(second));
  expect(await pending).toBe(false);
  expect(audio.store.getState().current).toBeUndefined();
  expect(
    events.filter((event) => event === "engine:file:///temporary"),
  ).toHaveLength(1);
  await audio.close();
  stop();
});

test("removing the current track advances to Up Next without keeping it in history", async () => {
  const { audio, events } = fixture();
  await audio.play(song);
  audio.enqueue(second);
  audio.remove(trackId(song));
  await tick();
  expect(audio.store.getState().current?.track.title).toBe("Second song");
  expect(audio.store.getState().upcoming).toEqual([]);
  expect(audio.store.getState().history).toEqual([]);
  expect(events.filter((event) => event === "release:First song")).toHaveLength(
    1,
  );
  await audio.next();
  expect(audio.store.getState().current?.track.title).toBe("Second song");
  await audio.close();
});
