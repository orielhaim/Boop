import { useEffect, useState } from "react";
import type { VideoPlayer } from "expo-video";
import { I18nManager, Text, View, type TextStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import {
  observeSubtitles,
  type SubtitleFrame,
} from "@/core/video/subtitles/sync";
import type { ExternalSubtitle } from "@/core/video/subtitles/tracks";
import type {
  CaptionAppearance,
  CueLayout,
  SubtitleCue,
} from "@/core/video/subtitles/types";

const presetColors = {
  source: { text: "#fff", background: "#000b" },
  contrast: { text: "#fff", background: "#000" },
  yellow: { text: "#ffeb60", background: "#000d" },
  clear: { text: "#fff", background: "transparent" },
} satisfies Record<
  CaptionAppearance["preset"],
  { text: string; background: string }
>;
const fontSizes = { small: 16, default: 20, large: 26 };

function alignment(align: CueLayout["align"]): TextStyle["textAlign"] {
  if (align === "start") return I18nManager.isRTL ? "right" : "left";
  if (align === "end") return I18nManager.isRTL ? "left" : "right";
  return align ?? "center";
}

function captionGroups(cues: readonly SubtitleCue[], useLayout: boolean) {
  const groups = new Map<string, { layout?: CueLayout; cues: SubtitleCue[] }>();
  for (const cue of cues) {
    const layout = useLayout ? cue.layout : undefined;
    const key = [layout?.x, layout?.y, layout?.width, layout?.align].join("/");
    const group = groups.get(key);
    if (group) group.cues.push(cue);
    else groups.set(key, { layout, cues: [cue] });
  }
  return groups;
}

export function Captions({
  player,
  track,
  offset,
  appearance,
  controlsVisible,
  compact = false,
}: {
  player: VideoPlayer;
  track: ExternalSubtitle;
  offset: number;
  appearance: CaptionAppearance;
  controlsVisible: boolean;
  compact?: boolean;
}) {
  return (
    <CaptionTimeline
      key={track.id}
      player={player}
      timeline={track.timeline}
      offset={offset}
      appearance={appearance}
      compact={compact}
      controlsVisible={controlsVisible}
    />
  );
}

function CaptionTimeline({
  player,
  timeline,
  offset,
  appearance,
  controlsVisible,
  compact,
}: {
  player: VideoPlayer;
  timeline: ExternalSubtitle["timeline"];
  offset: number;
  appearance: CaptionAppearance;
  controlsVisible: boolean;
  compact: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState<{
    timeline: typeof timeline;
    offset: number;
    frame: SubtitleFrame;
  }>();
  useEffect(
    () =>
      observeSubtitles(player, timeline, offset, (frame) =>
        setCurrent({ timeline, offset, frame }),
      ),
    [player, timeline, offset],
  );
  const frame =
    current?.timeline === timeline && current.offset === offset
      ? current.frame
      : undefined;
  if (!frame?.cues.length) return null;
  const colors = presetColors[appearance.preset];
  const fontSize = compact
    ? Math.min(15, fontSizes[appearance.size] * 0.63)
    : fontSizes[appearance.size];
  const preserveStyle = appearance.preset === "source";
  const groups = captionGroups(
    frame.cues,
    appearance.position === "source" && !compact,
  );
  return (
    <View
      pointerEvents="none"
      style={[
        styles.viewport,
        compact
          ? { left: 4, right: 4, top: 4, bottom: controlsVisible ? 29 : 7 }
          : {
              left: insets.left + 16,
              right: insets.right + 16,
              top: insets.top + (controlsVisible ? 52 : 16),
              bottom: insets.bottom + (controlsVisible ? 122 : 20),
            },
        appearance.position === "top" && styles.top,
      ]}
    >
      {Array.from(groups, ([key, { cues, layout }]) => {
        const width = Math.max(
          15,
          Math.min(100, layout?.width ?? (layout?.x === undefined ? 100 : 74)),
        );
        const x = Math.max(
          0,
          Math.min(100 - width, (layout?.x ?? 50) - width / 2),
        );
        const position = layout?.y === undefined ? undefined : "absolute";
        // Keep the baseline inside the safe caption area even for a bottom anchor.
        const top =
          layout?.y !== undefined ? Math.min(84, layout.y) : undefined;
        return (
          <View
            key={key}
            style={[
              styles.line,
              {
                position,
                width: width + "%",
                left: x + "%",
                top: top === undefined ? undefined : top + "%",
                alignItems:
                  layout?.align === "left"
                    ? "flex-start"
                    : layout?.align === "right"
                      ? "flex-end"
                      : "center",
              },
            ]}
          >
            {cues.map((cue, index) => (
              <Text
                key={index}
                maxFontSizeMultiplier={compact ? 1.4 : undefined}
                style={[
                  styles.text,
                  {
                    fontSize,
                    color: colors.text,
                    textAlign: alignment(layout?.align),
                    backgroundColor: colors.background,
                    paddingHorizontal: compact ? 3 : 8,
                    paddingVertical: compact ? 0 : 3,
                  },
                  appearance.preset === "clear" && styles.shadow,
                ]}
              >
                {cue.runs.map((run, runIndex) => {
                  const future =
                    run.from !== undefined && frame.time < run.from;
                  return (
                    <Text
                      key={runIndex}
                      accessibilityLabel={
                        run.speaker
                          ? run.speaker +
                            ": " +
                            run.text +
                            (run.ruby ? " " + run.ruby : "")
                          : undefined
                      }
                      style={{
                        color: future
                          ? "#aaa"
                          : preserveStyle
                            ? run.style?.color
                            : undefined,
                        backgroundColor: preserveStyle
                          ? run.style?.background
                          : undefined,
                        fontWeight: run.style?.bold ? "bold" : undefined,
                        fontStyle: run.style?.italic ? "italic" : undefined,
                        textDecorationLine: run.style?.underline
                          ? "underline"
                          : undefined,
                      }}
                    >
                      {run.text}
                      {run.ruby && (
                        <Text style={styles.annotation}>{" " + run.ruby}</Text>
                      )}
                    </Text>
                  );
                })}
              </Text>
            ))}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  viewport: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    zIndex: 3,
  },
  top: { justifyContent: "flex-start" },
  line: { gap: 3, marginVertical: 2 },
  text: {
    borderRadius: theme.radius.small,
    writingDirection: "auto",
    overflow: "hidden",
  },
  annotation: { fontSize: 12, fontStyle: "italic" },
  shadow: {
    textShadowColor: "#000",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
}));
