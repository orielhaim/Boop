import {
  type PlaybackSource,
  TranscriptText,
  useTranscriptPlayback,
  wordIndexAt,
} from "@hzblj/expo-speech";
import type { StoredTranscript } from "@/core/speech/types";
import { useTheme } from "@/theme";

export default function VoiceTranscriptText({
  transcript,
  player,
  seek,
  color,
  highlight,
}: {
  transcript: StoredTranscript;
  player: PlaybackSource | null;
  seek?: (seconds: number) => void | Promise<void>;
  color: string;
  highlight: boolean;
}) {
  const { colors } = useTheme();
  const playback = useTranscriptPlayback(
    highlight ? transcript : null,
    highlight ? player : null,
  );
  const initial =
    player && player.currentTime > 0
      ? wordIndexAt(transcript, player.currentTime)
      : -1;
  return (
    <TranscriptText
      transcript={transcript}
      wordIndex={
        highlight && player
          ? playback.wordIndex === -1
            ? initial
            : playback.wordIndex
          : -1
      }
      style={{ color, fontSize: 15, writingDirection: "auto" }}
      spokenWordStyle={{ textDecorationLine: "underline" }}
      activeWordStyle={{ color: colors.accent, fontWeight: "bold" }}
      selectable
      onWordPress={
        player && seek && transcript.words.length <= 150
          ? (word) => {
              void Promise.resolve(seek(word.start)).catch(() => undefined);
            }
          : undefined
      }
    />
  );
}
