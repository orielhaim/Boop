import { type DownloadSource, sourceId } from "@/core/downloads/types";
import type { DownloadFile, ProgressiveRead } from "@/core/downloads/transport";

export type MediaSource =
  | { kind: "attachment"; source: DownloadSource }
  | { kind: "local"; file: DownloadFile; id: string }
  | { kind: "device"; file: string; title: string; type: string };

export const mediaId = (source: MediaSource) =>
  source.kind === "attachment"
    ? sourceId(source.source)
    : source.kind === "local"
      ? source.id
      : source.file;

export type LocalMediaHandle = {
  kind: "local";
  file: DownloadFile;
  uri: string;
  expiresAt: number | null;
  release(): Promise<void>;
};

export type ProgressiveMediaHandle = ProgressiveRead & {
  kind: "progressive";
  sourceId: string;
  mimeType: string;
  expiresAt: number | null;
  cancelReads(): Promise<void>;
};

export type MediaHandle = LocalMediaHandle | ProgressiveMediaHandle;
