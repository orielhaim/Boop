import { getDocumentAsync } from "expo-document-picker";
import { readSelectedSubtitles } from "@/core/video/subtitle-files";
import { relatedSubtitle } from "@/core/video/subtitles/tracks";

export async function pickLocalSubtitles(
  videoName: string,
  signal: AbortSignal,
) {
  const result = await getDocumentAsync({
    copyToCacheDirectory: false,
    multiple: true,
  });
  signal.throwIfAborted();
  if (result.canceled) return;
  const inputs = await readSelectedSubtitles(result.assets, { signal });
  if (!inputs.length) throw new Error("SubtitleUnavailable");
  return inputs.map((input) => ({
    ...input,
    language:
      input.language ?? relatedSubtitle(videoName, input.name)?.language,
  }));
}
