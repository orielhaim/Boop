import { useEvent } from "expo";
import type { VideoPlayer } from "expo-video";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { subtitleAt, type LocalCaptions } from "@/core/video/subtitles";
import { MenuRow } from "./viewer";
import { pickLocalSubtitles } from "./local-subtitles";

export function CaptionOptions({
  captions,
  update,
  close,
  onError,
}: {
  captions?: LocalCaptions;
  update(captions?: LocalCaptions): void;
  close(): void;
  onError(): void;
}) {
  const { t } = useTranslation("video");
  async function pick() {
    close();
    try {
      const captions = await pickLocalSubtitles();
      if (captions) update(captions);
    } catch {
      onError();
    }
  }
  const offset = (amount: number) => {
    if (captions)
      update({
        ...captions,
        offset: Math.max(-10, Math.min(10, captions.offset + amount)),
      });
  };
  return (
    <>
      <MenuRow label={t("viewer.openSubtitles")} action={() => void pick()} />
      {captions && (
        <>
          <MenuRow
            label={captions.name}
            detail={t("viewer.removeSubtitles")}
            action={() => {
              update();
              close();
            }}
          />
          <MenuRow
            label={t("viewer.largerSubtitles")}
            selected={captions.large}
            action={() => update({ ...captions, large: !captions.large })}
          />
          <MenuRow
            label={t("viewer.earlierSubtitles")}
            detail={captions.offset.toFixed(1) + " s"}
            action={() => offset(-0.5)}
          />
          <MenuRow
            label={t("viewer.laterSubtitles")}
            detail={captions.offset.toFixed(1) + " s"}
            action={() => offset(0.5)}
          />
        </>
      )}
    </>
  );
}

export function Captions({
  player,
  captions,
  controlsVisible,
}: {
  player: VideoPlayer;
  captions: LocalCaptions;
  controlsVisible: boolean;
}) {
  const { bottom } = useSafeAreaInsets();
  const { currentTime } = useEvent(player, "timeUpdate", {
    currentTime: player.currentTime,
    bufferedPosition: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
  });
  const cue = subtitleAt(captions.cues, currentTime - captions.offset);
  if (!cue) return null;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.captions,
        { bottom: bottom + (controlsVisible ? 156 : 24) },
      ]}
    >
      <Text style={[styles.cue, captions.large && styles.large]}>{cue}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  captions: {
    position: "absolute",
    start: 16,
    end: 16,
    alignItems: "center",
    zIndex: 3,
  },
  cue: {
    color: "#fff",
    textAlign: "center",
    fontSize: 19,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: "#000d",
  },
  large: { fontSize: 25 },
});
