import { File } from "expo-file-system";
import { subtitleFormat } from "./subtitles/parse";
import { relatedSubtitle, type SubtitleInput } from "./subtitles/tracks";
import {
  subtitleByteLimit,
  subtitleSessionByteLimit,
  subtitleTrackLimit,
} from "./subtitles/types";

type SelectedFile = { name: string; uri: string; size?: number };

export async function readSelectedSubtitles(
  files: readonly SelectedFile[],
  options: { relatedTo?: string; signal?: AbortSignal } = {},
) {
  const { relatedTo, signal } = options;
  const inputs: SubtitleInput[] = [];
  let remaining = subtitleSessionByteLimit;
  for (const asset of files) {
    if (inputs.length >= subtitleTrackLimit || remaining <= 0) break;
    signal?.throwIfAborted();
    const match = relatedTo
      ? relatedSubtitle(relatedTo, asset.name)
      : undefined;
    if (!subtitleFormat(asset.name) || (relatedTo && !match)) continue;
    if (!asset.uri.startsWith("file://") && !asset.uri.startsWith("content://"))
      continue;
    const maximum = Math.min(subtitleByteLimit, remaining);
    if (asset.size !== undefined && asset.size > maximum) continue;
    try {
      const handle = new File(asset.uri).open();
      try {
        const bytes = await handle.readBytes(maximum + 1);
        signal?.throwIfAborted();
        if (!bytes.length || bytes.length > maximum) continue;
        inputs.push({ name: asset.name, bytes, language: match?.language });
        remaining -= bytes.length;
      } finally {
        handle.close();
      }
    } catch {
      signal?.throwIfAborted();
      // A provider can revoke access to one file without invalidating the batch.
    }
  }
  return inputs;
}
