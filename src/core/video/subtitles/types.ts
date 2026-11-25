export type SubtitleFormat = "srt" | "vtt" | "ass" | "ssa";
export const subtitleByteLimit = 2 * 1024 * 1024;
export const subtitleTrackLimit = 8;
export const subtitleSessionByteLimit = 4 * 1024 * 1024;
export const cueLimit = 10_000;
export const cueTextLimit = 2048;
export const subtitleRunLimit = 30_000;
export const subtitleSessionRunLimit = 60_000;
export const visibleCueLimit = 8;

export type CaptionStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  background?: string;
};
export type CaptionRun = {
  text: string;
  style?: CaptionStyle;
  speaker?: string;
  ruby?: string;
  from?: number;
};
export type CueLayout = {
  align?: "left" | "center" | "right" | "start" | "end";
  x?: number;
  y?: number;
  width?: number;
};
export type SubtitleCue = {
  start: number;
  end: number;
  runs: readonly CaptionRun[];
  layout?: CueLayout;
};
export const captionPresets = [
  "source",
  "contrast",
  "yellow",
  "clear",
] as const;
export const captionSizes = ["small", "default", "large"] as const;
export const captionPositions = ["source", "bottom", "top"] as const;
export type CaptionAppearance = {
  preset: (typeof captionPresets)[number];
  size: (typeof captionSizes)[number];
  position: (typeof captionPositions)[number];
};
export const defaultCaptionAppearance: CaptionAppearance = {
  preset: "source",
  size: "default",
  position: "source",
};
