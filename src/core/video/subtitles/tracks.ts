import type { SubtitleTrack } from "expo-video";
import type { SubtitleEncoding } from "./encoding";
import { parseSubtitle, subtitleFormat } from "./parse";
import { indexSubtitles, type SubtitleTimeline } from "./timeline";
import type { SubtitleFormat } from "./types";

export const androidExternalSubtitleId = "boop-external-subtitle";
export type SubtitleInput = {
  name: string;
  bytes: Uint8Array;
  language?: string;
};
export type ExternalSubtitle = {
  id: number;
  name: string;
  language?: string;
  format: SubtitleFormat;
  encoding: SubtitleEncoding;
  runCount: number;
  timeline: SubtitleTimeline;
};
export type SubtitleSelection =
  | { kind: "off" }
  | { kind: "embedded"; track: SubtitleTrack }
  | { kind: "external"; id: number };
export type SubtitleState = {
  selection: SubtitleSelection;
  tracks: readonly ExternalSubtitle[];
  rendering: "fallback" | "native";
  offset: number;
};

export function loadSubtitle(
  input: SubtitleInput,
  id: number,
  encoding: SubtitleEncoding = "auto",
): ExternalSubtitle | undefined {
  const subtitle = parseSubtitle(input.bytes, input.name, encoding);
  if (!subtitle) return;
  return {
    id,
    name: input.name,
    language: input.language,
    format: subtitle.format,
    encoding,
    runCount: subtitle.cues.reduce((count, cue) => count + cue.runs.length, 0),
    timeline: indexSubtitles(subtitle.cues),
  };
}

export function selectedExternal(state: SubtitleState) {
  const selection = state.selection;
  return selection.kind === "external"
    ? state.tracks.find((track) => track.id === selection.id)
    : undefined;
}

function basename(name: string) {
  return (name.split(/[\\/]/).at(-1) ?? "").normalize("NFC").toLowerCase();
}

// Providers supply only filenames from an already authorized local scope.
export function relatedSubtitle(video: string, candidate: string) {
  if (!subtitleFormat(candidate)) return undefined;
  const videoName = basename(video);
  const subtitleName = basename(candidate);
  const dot = videoName.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const stem = videoName.slice(0, dot);
  const related = subtitleName.slice(0, subtitleName.lastIndexOf("."));
  if (related === stem) return {};
  if (!related.startsWith(stem + ".")) return undefined;
  const language = related.slice(stem.length + 1);
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)
    ? { language }
    : undefined;
}
