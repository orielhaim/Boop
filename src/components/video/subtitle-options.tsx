import { useState } from "react";
import type { SubtitleTrack } from "expo-video";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  captionPositions,
  captionPresets,
  captionSizes,
  type CaptionAppearance,
} from "@/core/video/subtitles/types";
import {
  subtitleEncodings,
  type SubtitleEncoding,
} from "@/core/video/subtitles/encoding";
import type {
  ExternalSubtitle,
  SubtitleInput,
  SubtitleSelection,
  SubtitleState,
} from "@/core/video/subtitles/tracks";
import { pickLocalSubtitles } from "./local-subtitles";
import { MenuRow } from "./menu-row";

type Props = {
  state: SubtitleState;
  embedded: readonly SubtitleTrack[];
  appearance: CaptionAppearance;
  canImport: boolean;
  videoName: string;
  importSignal(): AbortSignal | undefined;
  select(selection: SubtitleSelection): void;
  add(inputs: SubtitleInput[]): number;
  remove(id: number): void;
  setEncoding(id: number, encoding: SubtitleEncoding): boolean;
  setOffset(offset: number): void;
  setAppearance(appearance: CaptionAppearance): void;
  close(): void;
  onError(): void;
};

type Section = "main" | "appearance" | "encoding" | "timing";

export function SubtitleOptions({
  state,
  embedded,
  appearance,
  canImport,
  videoName,
  importSignal,
  select,
  add,
  remove,
  setEncoding,
  setOffset,
  setAppearance,
  close,
  onError,
}: Props) {
  const { t } = useTranslation("video");
  const [section, setSection] = useState<Section>("main");
  const [encodingTrack, setEncodingTrack] = useState<ExternalSubtitle>();
  const [picking, setPicking] = useState(false);
  const offset = t("viewer.subtitleOffsetValue", {
    seconds: state.offset.toFixed(1),
  });

  async function pick() {
    const signal = importSignal();
    if (!signal || picking) return;
    setPicking(true);
    try {
      const inputs = await pickLocalSubtitles(videoName, signal);
      if (!signal.aborted && inputs?.length && !add(inputs)) onError();
    } catch {
      if (!signal.aborted) onError();
    } finally {
      setPicking(false);
    }
  }

  if (section === "appearance")
    return (
      <>
        <MenuRow
          label={t("viewer.backToSubtitles")}
          action={() => setSection("main")}
        />
        <Text style={styles.heading}>{t("viewer.captionStyle")}</Text>
        {captionPresets.map((preset) => (
          <MenuRow
            key={preset}
            label={t(`viewer.captionPreset.${preset}`)}
            selected={appearance.preset === preset}
            action={() => setAppearance({ ...appearance, preset })}
          />
        ))}
        <Text style={styles.heading}>{t("viewer.captionSize")}</Text>
        {captionSizes.map((size) => (
          <MenuRow
            key={size}
            label={t(`viewer.captionSizeOption.${size}`)}
            selected={appearance.size === size}
            action={() => setAppearance({ ...appearance, size })}
          />
        ))}
        <Text style={styles.heading}>{t("viewer.captionPosition")}</Text>
        {captionPositions.map((position) => (
          <MenuRow
            key={position}
            label={t(`viewer.captionPositionOption.${position}`)}
            selected={appearance.position === position}
            action={() => setAppearance({ ...appearance, position })}
          />
        ))}
      </>
    );

  if (section === "encoding" && encodingTrack)
    return (
      <>
        <MenuRow
          label={t("viewer.backToSubtitles")}
          action={() => setSection("main")}
        />
        <Text style={styles.heading}>{t("viewer.subtitleEncoding")}</Text>
        {subtitleEncodings.map((encoding) => (
          <MenuRow
            key={encoding}
            label={encoding}
            selected={encodingTrack.encoding === encoding}
            action={() => {
              if (setEncoding(encodingTrack.id, encoding)) {
                setEncodingTrack({ ...encodingTrack, encoding });
                setSection("main");
              } else onError();
            }}
          />
        ))}
      </>
    );

  if (section === "timing")
    return (
      <>
        <MenuRow
          label={t("viewer.backToSubtitles")}
          action={() => setSection("main")}
        />
        <Text style={styles.heading}>{offset}</Text>
        <MenuRow
          label={t("viewer.earlierSubtitles")}
          action={() => setOffset(Math.max(-600, state.offset - 0.1))}
        />
        <MenuRow
          label={t("viewer.laterSubtitles")}
          action={() => setOffset(Math.min(600, state.offset + 0.1))}
        />
        <MenuRow
          label={t("viewer.resetSubtitleOffset")}
          action={() => setOffset(0)}
        />
      </>
    );

  const selection = state.selection;
  const selectedExternal =
    selection.kind === "external"
      ? state.tracks.find((track) => track.id === selection.id)
      : undefined;
  return (
    <>
      <MenuRow
        label={t("viewer.subtitlesOff")}
        selected={selection.kind === "off"}
        action={() => {
          select({ kind: "off" });
          close();
        }}
      />
      {embedded.map((track, index) => (
        <MenuRow
          key={track.id ?? index}
          label={
            track.label ||
            track.name ||
            track.language ||
            t("viewer.subtitleTrackName", { number: index + 1 })
          }
          selected={
            selection.kind === "embedded" && selection.track.id === track.id
          }
          action={() => {
            select({ kind: "embedded", track });
            close();
          }}
        />
      ))}
      {state.tracks.map((track) => (
        <MenuRow
          key={track.id}
          label={track.name}
          detail={track.language}
          selected={track.id === selectedExternal?.id}
          action={() => {
            select({ kind: "external", id: track.id });
            close();
          }}
        />
      ))}
      {selectedExternal && (
        <>
          <MenuRow
            label={t("viewer.removeSubtitles")}
            action={() => {
              remove(selectedExternal.id);
            }}
          />
          <MenuRow
            label={t("viewer.subtitleEncoding")}
            detail={selectedExternal.encoding}
            action={() => {
              setEncodingTrack(selectedExternal);
              setSection("encoding");
            }}
          />
          <MenuRow
            label={t("viewer.subtitleTiming")}
            detail={offset}
            action={() => setSection("timing")}
          />
        </>
      )}
      {selectedExternal && (
        <MenuRow
          label={t("viewer.captionStyle")}
          detail={t(`viewer.captionPreset.${appearance.preset}`)}
          action={() => setSection("appearance")}
        />
      )}
      {canImport && (
        <MenuRow
          label={t("viewer.openSubtitles")}
          disabled={picking}
          action={() => void pick()}
        />
      )}
      {selectedExternal && (
        <View style={styles.note}>
          <Text style={styles.noteText}>
            {t(`viewer.subtitleRendering.${state.rendering}`)}
          </Text>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  heading: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 12,
    fontWeight: "700",
    paddingTop: 12,
    paddingBottom: 4,
  },
  note: { paddingVertical: 12 },
  noteText: { color: "rgba(255,255,255,0.6)", fontSize: 12 },
});
