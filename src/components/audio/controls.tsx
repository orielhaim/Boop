import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useStore } from "zustand";
import { ActionMenu } from "@/components/ui/action-menu";
import { Icon, Ink } from "@/components/ui/kit";
import { speeds } from "@/core/audio/types";
import { formatDuration } from "@/i18n/format";
import { useLocal } from "@/services/local-context";
import { useTheme } from "@/theme";

export function SpeedControl({
  compact = false,
  player = false,
}: {
  compact?: boolean;
  player?: boolean;
}) {
  const { t } = useTranslation("audio");
  const { audio } = useLocal();
  const speed = useStore(audio.store, (state) =>
    player && state.pausedMusic ? state.pausedMusic.speed : state.speed,
  );
  return (
    <ActionMenu
      label={t("speed")}
      value={t("rate", { speed })}
      actions={speeds.map((value) => ({
        id: String(value),
        title: t("rate", { speed: value }),
        state: value === speed ? "on" : "off",
      }))}
      onSelect={(id) => {
        const selected = speeds.find((value) => String(value) === id);
        if (selected !== undefined)
          (player ? audio.player.speed : audio.speed)(selected);
      }}
    >
      <View style={[styles.button, compact && styles.compactSpeed]}>
        <Ink kind="caption">{t("rate", { speed })}</Ink>
      </View>
    </ActionMenu>
  );
}

export function SeekControl({
  position,
  duration,
  seek,
  children,
  compact = false,
  style,
}: {
  position: number;
  duration: number;
  seek(position: number): void;
  children?: ReactNode;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation("audio");
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const [preview, setPreview] = useState<number>();
  const value =
    preview ?? (duration > 0 ? Math.min(1, position / duration) : 0);
  const fraction = (x: number) => Math.min(1, Math.max(0, x / width));
  const pan = useMemo(() => {
    const progress = (x: number) => Math.min(1, Math.max(0, x / width));
    return Gesture.Pan()
      .enabled(duration > 0 && width > 0)
      .activeOffsetX([-5, 5])
      .failOffsetY([-12, 12])
      .runOnJS(true)
      .onUpdate(({ x }) => setPreview(progress(x)))
      .onEnd(({ x }) => seek(progress(x) * duration))
      .onFinalize(() => setPreview(undefined));
  }, [duration, seek, width]);
  // Time and waveforms always run left to right.
  return (
    <GestureDetector gesture={pan}>
      <Pressable
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t("seek")}
        accessibilityValue={{
          min: 0,
          max: Math.max(1, Math.floor(duration)),
          now: Math.floor(position),
          text: t("time", {
            elapsed: formatDuration(position),
            total: formatDuration(duration),
          }),
        }}
        accessibilityActions={[
          { name: "increment", label: t("forward") },
          { name: "decrement", label: t("back") },
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          seek(position + (nativeEvent.actionName === "increment" ? 10 : -10));
        }}
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        onPress={({ nativeEvent }) => {
          if (width > 0) seek(fraction(nativeEvent.locationX) * duration);
        }}
        style={[styles.seek, compact && styles.compact, style]}
      >
        <View pointerEvents="none" style={styles.seekContent}>
          {children ?? (
            <View style={[styles.rail, { backgroundColor: colors.line }]}>
              <View
                style={[
                  styles.fill,
                  { width: `${value * 100}%`, backgroundColor: colors.accent },
                ]}
              />
            </View>
          )}
        </View>
      </Pressable>
    </GestureDetector>
  );
}

export function AudioTime({
  elapsed,
  total,
}: {
  elapsed: number;
  total: number;
}) {
  return (
    <View style={styles.time}>
      <AudioTimestamp seconds={elapsed} />
      <AudioTimestamp seconds={total} />
    </View>
  );
}

export function AudioTimestamp({ seconds }: { seconds: number }) {
  return (
    <Ink muted kind="caption" style={styles.digits}>
      {formatDuration(seconds)}
    </Ink>
  );
}

export function TrackMark({
  voice,
  size = 24,
}: {
  voice?: boolean;
  size?: number;
}) {
  return <Icon name={voice ? "microphone" : "audio"} size={size} />;
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 4,
  },
  compactSpeed: { minHeight: 24 },
  seek: { minHeight: 44, justifyContent: "center", direction: "ltr" },
  compact: { minHeight: 30 },
  seekContent: { width: "100%" },
  rail: { height: 5, borderRadius: 3, overflow: "hidden" },
  fill: { height: 5, borderRadius: 3 },
  time: {
    direction: "ltr",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  digits: { fontVariant: ["tabular-nums"], writingDirection: "ltr" },
});
