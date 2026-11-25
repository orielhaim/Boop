import type { VideoPlayer } from "expo-video";
import type { SubtitleEncoding } from "./encoding";
import { nativeSubtitle } from "./native-vtt";
import {
  androidExternalSubtitleId,
  loadSubtitle,
  selectedExternal,
  type SubtitleInput,
  type SubtitleSelection,
  type SubtitleState,
} from "./tracks";
import {
  subtitleByteLimit,
  subtitleSessionByteLimit,
  subtitleSessionRunLimit,
  subtitleTrackLimit,
  type CaptionAppearance,
} from "./types";

export const emptySubtitles: SubtitleState = {
  selection: { kind: "off" },
  rendering: "native",
  offset: 0,
  tracks: [],
};

export function bindSubtitles(
  player: VideoPlayer,
  options: {
    active(): boolean;
    allowExternal: boolean;
    initialOffset: number;
    saveOffset(offset: number): void;
    publish(state: SubtitleState): void;
    appearance(): CaptionAppearance;
  },
) {
  const initialTrack = player.subtitleTrack;
  let state: SubtitleState = {
    ...emptySubtitles,
    offset: options.initialOffset,
    selection: initialTrack
      ? { kind: "embedded", track: initialTrack }
      : { kind: "off" },
  };
  let revision = 0;
  let nextId = 0;
  let nativeAttached = false;
  let work = Promise.resolve();
  const originals = new Map<number, SubtitleInput>();

  function publish(patch: Partial<SubtitleState>) {
    state = { ...state, ...patch };
    options.publish(state);
  }

  function configure() {
    const version = ++revision;
    const selection = state.selection;
    const track = selectedExternal(state);
    const { preset, size, position } = options.appearance();
    const canUseNative =
      typeof player.setExternalSubtitle === "function" &&
      preset === "source" &&
      size === "default" &&
      position === "source";
    const vtt =
      track && canUseNative ? nativeSubtitle(track, state.offset) : undefined;
    const fallback = track && !vtt ? "fallback" : "native";
    player.subtitleTrack = null;
    publish({ rendering: fallback });

    work = work
      .then(async () => {
        if (!options.active() || version !== revision) return;
        if (vtt || nativeAttached) {
          try {
            nativeAttached = !!vtt;
            await player.setExternalSubtitle?.(vtt ?? null);
          } catch {
            if (track && options.active() && version === revision)
              publish({ rendering: "fallback" });
          }
          if (!options.active() || version !== revision) return;
        }
        if (selection.kind === "embedded") {
          player.subtitleTrack =
            player.availableSubtitleTracks.find(
              (candidate) => candidate.id === selection.track.id,
            ) ?? null;
        } else if (!vtt) {
          player.subtitleTrack = null;
        }
      })
      .catch(() => {
        if (track && options.active() && version === revision)
          publish({ rendering: "fallback" });
      });
  }

  const trackListener = player.addListener(
    "subtitleTrackChange",
    ({ subtitleTrack }) => {
      if (revision !== 0 || !options.active()) return;
      publish({
        selection: subtitleTrack
          ? { kind: "embedded", track: subtitleTrack }
          : { kind: "off" },
      });
    },
  );

  return {
    get state() {
      return state;
    },
    settled() {
      return work;
    },
    add(inputs: readonly SubtitleInput[]) {
      if (!options.active() || !options.allowExternal) return 0;
      let size = 0;
      let runs = state.tracks.reduce(
        (total, track) => total + track.runCount,
        0,
      );
      for (const input of originals.values()) size += input.bytes.byteLength;
      const added = [];
      for (const input of inputs) {
        if (originals.size >= subtitleTrackLimit) break;
        const bytes = input.bytes.byteLength;
        if (
          !bytes ||
          bytes > subtitleByteLimit ||
          size + bytes > subtitleSessionByteLimit
        )
          continue;
        const track = loadSubtitle(input, ++nextId);
        if (!track || runs + track.runCount > subtitleSessionRunLimit) continue;
        originals.set(track.id, input);
        size += bytes;
        runs += track.runCount;
        added.push(track);
      }
      if (added.length) {
        publish({
          tracks: [...state.tracks, ...added],
          selection: { kind: "external", id: added[0].id },
        });
        configure();
      }
      return added.length;
    },
    select(selection: SubtitleSelection) {
      if (!options.active()) return;
      if (selection.kind === "external" && !originals.has(selection.id)) return;
      if (
        selection.kind === "embedded" &&
        (selection.track.id === androidExternalSubtitleId ||
          !player.availableSubtitleTracks.some(
            (track) => track.id === selection.track.id,
          ))
      )
        return;
      publish({ selection });
      configure();
    },
    remove(id: number) {
      if (!options.active() || !originals.delete(id)) return;
      const selected = selectedExternal(state)?.id === id;
      publish({
        tracks: state.tracks.filter((track) => track.id !== id),
        selection: selected ? { kind: "off" } : state.selection,
      });
      if (selected) configure();
    },
    encoding(id: number, encoding: SubtitleEncoding) {
      if (!options.active()) return false;
      const input = originals.get(id);
      if (!input) return false;
      const track = loadSubtitle(input, id, encoding);
      const otherRuns = state.tracks.reduce(
        (total, item) => total + (item.id === id ? 0 : item.runCount),
        0,
      );
      if (!track || otherRuns + track.runCount > subtitleSessionRunLimit)
        return false;
      publish({
        tracks: state.tracks.map((item) => (item.id === id ? track : item)),
      });
      if (selectedExternal(state)?.id === id) configure();
      return true;
    },
    offset(value: number) {
      if (
        !options.active() ||
        !Number.isFinite(value) ||
        !selectedExternal(state)
      )
        return;
      const offset =
        Math.round(Math.max(-600, Math.min(600, value)) * 100) / 100;
      if (state.offset === offset) return;
      publish({ offset });
      options.saveOffset(offset);
      configure();
    },
    appearanceChanged() {
      if (options.active() && selectedExternal(state)) configure();
    },
    close() {
      trackListener.remove();
      originals.clear();
      state = emptySubtitles;
      revision++;
    },
  };
}
