import type { DownloadSource } from "@/core/downloads/types";
import type { DownloadFile } from "@/core/downloads/transport";

export type VideoSource = (
  | { kind: "attachment"; source: DownloadSource }
  | { kind: "local"; id: string; file: DownloadFile }
) & {
  title: string;
  duration?: number;
  dimensions?: string | null;
  thumbhash?: string | null;
};

export const seekIntervals = [5, 10, 15, 30] as const;
export const pipModes = ["off", "inApp", "system"] as const;
export type VideoPreferences = {
  external: boolean;
  pipMode: (typeof pipModes)[number];
  advancedGestures: boolean;
  seekInterval: (typeof seekIntervals)[number];
  rememberPosition: boolean;
  allowBackground: boolean;
};

export function videoFile(name: string, mimeType: string) {
  const type = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  return (
    type.startsWith("video/") ||
    ((type === "" ||
      type === "application/octet-stream" ||
      type === "application/x-matroska") &&
      /\.(mp4|m4v|mov|webm|mkv|avi|3gp|3g2|mpeg|mpg|ts|m2ts|ogv)$/iu.test(name))
  );
}

export function videoOrigin(target: readonly [string, string, string, number]) {
  return `video-${target[0]}-${target[1]}-${target[3]}`;
}
