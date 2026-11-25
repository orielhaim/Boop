import { LinearGradient } from "expo-linear-gradient";
import {
  GlassSegmentedControl,
  GlassSegmentedControlItem,
} from "@/components/glassyui/glass-segmented-control";
import { Icon } from "@/components/ui/icon";
import { mediaMaterial } from "@/theme/tokens";
import { CaptionSample } from "./captions";
import { useState } from "react";
import type { SubtitleTrack } from "expo-video";
import { Pressable, Text, View } from "react-native";
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
  SubtitleInput,
  SubtitleSelection,
  SubtitleState,
} from "@/core/video/subtitles/tracks";
import { pickLocalSubtitles } from "./local-subtitles";
import { MenuRow } from "./menu-row";
import { useGlassTray } from "@/components/glassyui/glass-tray";

type Props = {
  screen?: "main" | "appearance" | "encoding" | "timing";
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
  onError(): void;
};

type Section = "main" | "appearance" | "encoding" | "timing";

export function SubtitleOptions({
  screen = "main",
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
  onError,
}: Props) {
  const { t } = useTranslation("video");
  const { push } = useGlassTray();
  const section: Section = screen;
  const [picking, setPicking] = useState(false);
  const offset = t("viewer.subtitleOffsetValue", {
    seconds: (state.offset > 0 ? "+" : "") + state.offset.toFixed(1),
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

  const encodingSelection = state.selection;
  const encodingTrack =
    section === "encoding" && encodingSelection.kind === "external"
      ? state.tracks.find((track) => track.id === encodingSelection.id)
      : undefined;

  if (section === "appearance") {
    return (
      <>
        <LinearGradient
          colors={[mediaMaterial.opaque, mediaMaterial.secondary]}
          start={{ x: 0, y: 0.2 }}
          end={{ x: 1, y: 0.8 }}
          style={[
            styles.preview,
            appearance.position === "top" && styles.previewTop,
          ]}
        >
          <CaptionSample appearance={appearance} text={t("viewer.preview")} />
        </LinearGradient>
        <View style={styles.presets}>
          {captionPresets.map((preset) => (
            <Pressable
              key={preset}
              accessibilityRole="radio"
              accessibilityState={{ checked: appearance.preset === preset }}
              accessibilityLabel={t(`viewer.captionPreset.${preset}`)}
              style={[
                styles.preset,
                appearance.preset === preset && styles.selectedPreset,
              ]}
              onPress={() => setAppearance({ ...appearance, preset })}
            >
              <CaptionSample
                appearance={{ ...appearance, preset, size: "default" }}
                text="Aa"
                compact
              />
              <Text style={styles.presetLabel}>
                {t(`viewer.captionPreset.${preset}`)}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.heading}>{t("viewer.captionSize")}</Text>
        <GlassSegmentedControl
          value={appearance.size}
          onValueChange={(value) => {
            const size = captionSizes.find((option) => option === value);
            if (size) setAppearance({ ...appearance, size });
          }}
        >
          {captionSizes.map((size) => (
            <GlassSegmentedControlItem key={size} value={size}>
              {t(`viewer.captionSizeOption.${size}`)}
            </GlassSegmentedControlItem>
          ))}
        </GlassSegmentedControl>
        <Text style={styles.heading}>{t("viewer.captionPosition")}</Text>
        <GlassSegmentedControl
          value={appearance.position}
          onValueChange={(value) => {
            const position = captionPositions.find(
              (option) => option === value,
            );
            if (position) setAppearance({ ...appearance, position });
          }}
        >
          {captionPositions.map((position) => (
            <GlassSegmentedControlItem key={position} value={position}>
              {t(`viewer.captionPositionOption.${position}`)}
            </GlassSegmentedControlItem>
          ))}
        </GlassSegmentedControl>
      </>
    );
  }

  if (section === "encoding" && encodingTrack) {
    const sample = encodingTrack.timeline.cues[0]?.runs
      .map((run) => run.text)
      .join("")
      .slice(0, 320);
    return (
      <>
        {!!sample && (
          <View style={styles.encodingPreview}>
            <Text style={styles.noteText} numberOfLines={5}>
              {sample}
            </Text>
          </View>
        )}
        {subtitleEncodings.map((encoding) => (
          <MenuRow
            key={encoding}
            label={encoding}
            selected={encodingTrack.encoding === encoding}
            action={() => {
              if (!setEncoding(encodingTrack.id, encoding)) onError();
            }}
          />
        ))}
      </>
    );
  }

  if (section === "timing") {
    const adjust = (direction: -1 | 1) =>
      setOffset(
        Math.max(
          -600,
          Math.min(600, (Math.round(state.offset * 10) + direction) / 10),
        ),
      );
    return (
      <>
        <View style={styles.syncRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("viewer.earlierSubtitles")}
            onPress={() => adjust(-1)}
            style={styles.step}
          >
            <Icon name="subtract" size={22} />
          </Pressable>
          <View style={styles.syncReadout}>
            <Text style={styles.offset} accessibilityLiveRegion="polite">
              {offset}
            </Text>
            <Text style={styles.noteText}>
              {t(
                state.offset === 0
                  ? "viewer.inSync"
                  : state.offset < 0
                    ? "viewer.offsetEarlier"
                    : "viewer.offsetLater",
              )}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("viewer.laterSubtitles")}
            onPress={() => adjust(1)}
            style={styles.step}
          >
            <Icon name="add" size={22} />
          </Pressable>
        </View>
        <MenuRow
          label={t("viewer.resetSubtitleOffset")}
          icon="refresh"
          disabled={state.offset === 0}
          action={() => setOffset(0)}
        />
      </>
    );
  }

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
        }}
      />
      {embedded.length > 0 && (
        <Text style={styles.heading}>{t("viewer.embeddedTracks")}</Text>
      )}
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
          }}
        />
      ))}
      {state.tracks.length > 0 && (
        <Text style={styles.heading}>{t("viewer.importedTracks")}</Text>
      )}
      {state.tracks.map((track) => (
        <MenuRow
          key={track.id}
          label={track.name}
          detail={track.language}
          selected={track.id === selectedExternal?.id}
          action={() => {
            select({ kind: "external", id: track.id });
          }}
        />
      ))}
      {selectedExternal && (
        <>
          <MenuRow
            label={t("viewer.removeSubtitles")}
            icon="trash"
            action={() => {
              remove(selectedExternal.id);
            }}
          />
          <MenuRow
            label={t("viewer.subtitleEncoding")}
            icon="language"
            navigates
            detail={selectedExternal.encoding}
            action={() => {
              push("subtitle-encoding");
            }}
          />
          <MenuRow
            label={t("viewer.subtitleTiming")}
            icon="time"
            navigates
            detail={offset}
            action={() => push("subtitle-timing")}
          />
        </>
      )}
      {selectedExternal && (
        <MenuRow
          label={t("viewer.captionStyle")}
          icon="palette"
          navigates
          detail={t(`viewer.captionPreset.${appearance.preset}`)}
          action={() => push("subtitle-appearance")}
        />
      )}
      {canImport && (
        <MenuRow
          label={t("viewer.openSubtitles")}
          icon="add"
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

const styles = StyleSheet.create((theme) => ({
  heading: {
    ...theme.type.caption,
    fontWeight: "600",
    color: theme.colors.muted,
    paddingHorizontal: theme.space.sm,
    marginTop: theme.space.sm,
  },
  note: { paddingHorizontal: theme.space.sm, paddingVertical: theme.space.xs },
  noteText: {
    ...theme.type.caption,
    color: theme.colors.muted,
    writingDirection: "auto",
  },
  preview: {
    minHeight: 106,
    alignItems: "center",
    justifyContent: "flex-end",
    borderRadius: theme.radius.group,
    padding: theme.space.md,
  },
  previewTop: { justifyContent: "flex-start" },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.xs },
  preset: {
    flexGrow: 1,
    flexBasis: "22%",
    minHeight: 58,
    paddingHorizontal: theme.space.xs,
    paddingVertical: theme.space.sm,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space.xs,
    backgroundColor: theme.colors.recessed,
    borderRadius: theme.radius.input,
  },
  selectedPreset: {
    backgroundColor: theme.colors.selected,
    boxShadow: `inset 0px 0px 0px 1px ${theme.colors.accent}`,
  },
  presetLabel: {
    ...theme.type.meta,
    color: theme.colors.text,
    textAlign: "center",
  },
  syncRow: {
    minHeight: 104,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.sm,
  },
  syncReadout: { flex: 1, alignItems: "center", gap: theme.space.xs },
  offset: {
    ...theme.type.heading,
    fontSize: 24,
    color: theme.colors.accent,
    fontVariant: ["tabular-nums"],
  },
  step: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.round,
    backgroundColor: theme.colors.recessed,
  },
  encodingPreview: {
    minHeight: 55,
    backgroundColor: theme.colors.recessed,
    borderRadius: theme.radius.input,
    padding: theme.space.md,
  },
}));
