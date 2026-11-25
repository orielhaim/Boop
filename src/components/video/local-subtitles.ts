import { getDocumentAsync } from "expo-document-picker";
import { File } from "expo-file-system";
import {
  readSubtitles,
  subtitleByteLimit,
  type LocalCaptions,
} from "@/core/video/subtitles";

export async function pickLocalSubtitles(): Promise<LocalCaptions | undefined> {
  const result = await getDocumentAsync({ copyToCacheDirectory: false });
  const asset = result.assets?.[0];
  if (!asset) return;
  if (
    !/\.(srt|vtt)$/iu.test(asset.name) ||
    (asset.size ?? 0) > subtitleByteLimit
  )
    throw new Error("SubtitleUnavailable");
  const file = new File(asset.uri).open();
  try {
    const cues = readSubtitles(await file.readBytes(subtitleByteLimit + 1));
    if (!cues.length) throw new Error("SubtitleUnavailable");
    return { name: asset.name, cues, offset: 0, large: false };
  } finally {
    file.close();
  }
}
