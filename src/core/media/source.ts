import { type DownloadSource, sourceId } from "@/core/downloads/types";
import type { DownloadFile } from "@/core/downloads/transport";

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

export type MediaHandle = {
  file: DownloadFile;
  uri: string;
  expiresAt: number | null;
  release(): Promise<void>;
};
