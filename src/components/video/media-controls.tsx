import {
  createContext,
  useContext,
  type ComponentRef,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  GlassSurface,
  type GlassSurfaceProps,
} from "@/components/glassyui/glass-surface";
import { Icon, type IconName } from "@/components/ui/icon";
import { useTheme } from "@/theme";
import { mediaMaterial } from "@/theme/tokens";

export const VideoBlurTarget = createContext<
  RefObject<ComponentRef<typeof View> | null> | undefined
>(undefined);

export function VideoGlass(
  props: Omit<GlassSurfaceProps, "preset" | "blurTarget">,
) {
  const blurTarget = useContext(VideoBlurTarget);
  return <GlassSurface {...props} preset="cinematic" blurTarget={blurTarget} />;
}

function MediaGlyph({
  name,
  size,
  color = mediaMaterial.ink,
}: {
  name: IconName;
  size: number;
  color?: string;
}) {
  return (
    <View pointerEvents="none">
      <View style={styles.glyphShadow}>
        <Icon name={name} size={size} color={mediaMaterial.shade} />
      </View>
      <Icon name={name} size={size} color={color} />
    </View>
  );
}

export function MediaControl({
  label,
  icon,
  onPress,
  active,
  size = "normal",
  glass = false,
  children,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  active?: boolean;
  size?: "normal" | "large";
  glass?: boolean;
  children?: ReactNode;
}) {
  const control = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={
        active === undefined ? undefined : { selected: active }
      }
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        size === "large" && styles.largeControl,
        (active || pressed) && styles.highlight,
        pressed && styles.pressed,
      ]}
    >
      {icon && (
        <MediaGlyph
          name={icon}
          size={size === "large" ? 29 : 20}
          color={active ? mediaMaterial.accent : mediaMaterial.ink}
        />
      )}
      {children}
    </Pressable>
  );
  return glass ? (
    <VideoGlass style={styles.pill}>{control}</VideoGlass>
  ) : (
    control
  );
}

export function ControlGroup({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <VideoGlass style={[styles.group, style]}>{children}</VideoGlass>;
}

export function VideoTransport({
  status,
  seekable,
  interval,
  play,
  seek,
}: {
  status: "playing" | "paused" | "loading" | "ended";
  seekable: boolean;
  interval: number;
  play: () => void;
  seek: (delta: number) => void;
}) {
  const { t } = useTranslation("video");
  const { reduceMotion } = useTheme();
  return (
    <View style={styles.transport} pointerEvents="box-none">
      {seekable && status !== "loading" && (
        <MediaControl
          glass
          label={t("viewer.seekBack", { seconds: interval })}
          onPress={() => seek(-interval)}
        >
          <View style={styles.skip}>
            <MediaGlyph name="rewind" size={32} color={mediaMaterial.ink} />
            <View
              style={styles.skipValue}
              pointerEvents="none"
              importantForAccessibility="no"
            >
              <Text style={styles.skipTime} allowFontScaling={false}>
                {interval}
              </Text>
            </View>
          </View>
        </MediaControl>
      )}
      {status === "loading" ? (
        <VideoGlass style={styles.pill} pointerEvents="none">
          <View style={[styles.control, styles.largeControl]}>
            <ActivityIndicator
              color={mediaMaterial.ink}
              accessibilityLabel={t("viewer.loading")}
            />
          </View>
        </VideoGlass>
      ) : (
        <MediaControl
          glass
          size="large"
          label={t(
            status === "playing"
              ? "viewer.pause"
              : status === "ended"
                ? "viewer.replay"
                : "viewer.play",
          )}
          onPress={play}
        >
          <Animated.View
            key={status}
            entering={reduceMotion ? undefined : FadeIn.duration(150)}
            exiting={reduceMotion ? undefined : FadeOut.duration(85)}
            style={styles.transportIcon}
          >
            <MediaGlyph
              name={
                status === "playing"
                  ? "pause"
                  : status === "ended"
                    ? "refresh"
                    : "play"
              }
              size={29}
              color={mediaMaterial.ink}
            />
          </Animated.View>
        </MediaControl>
      )}
      {seekable && status !== "loading" && (
        <MediaControl
          glass
          label={t("viewer.seekForward", { seconds: interval })}
          onPress={() => seek(interval)}
        >
          <View style={styles.skip}>
            <MediaGlyph name="refresh" size={32} color={mediaMaterial.ink} />
            <View
              style={styles.skipValue}
              pointerEvents="none"
              importantForAccessibility="no"
            >
              <Text style={styles.skipTime} allowFontScaling={false}>
                {interval}
              </Text>
            </View>
          </View>
        </MediaControl>
      )}
    </View>
  );
}

export type GestureValue =
  | { kind: "brightness" | "volume"; value: number }
  | { kind: "speed"; value: number }
  | { kind: "seek"; value: number };

export function VideoGestureFeedback({ feedback }: { feedback: GestureValue }) {
  const { reduceMotion } = useTheme();
  const { kind, value } = feedback;
  const level = kind === "brightness" || kind === "volume";
  const left = kind === "brightness" || (kind === "seek" && value < 0);
  const icon =
    kind === "brightness"
      ? "brightness"
      : kind === "volume"
        ? "speaker"
        : kind === "speed"
          ? "play"
          : value < 0
            ? "rewind"
            : "refresh";
  const detail = level
    ? Math.round(value * 100) + "%"
    : kind === "speed"
      ? value + "×"
      : (value < 0 ? "−" : "+") + Math.abs(value) + " s";

  return (
    <Animated.View
      key={kind}
      entering={reduceMotion ? undefined : FadeIn.duration(110)}
      exiting={reduceMotion ? undefined : FadeOut.duration(160)}
      pointerEvents="none"
      style={[
        styles.feedbackPosition,
        left ? styles.feedbackLeft : styles.feedbackRight,
        kind === "speed" && styles.speedPosition,
      ]}
    >
      <VideoGlass style={styles.feedback}>
        <View style={styles.feedbackLabel}>
          <MediaGlyph name={icon} size={17} color={mediaMaterial.accent} />
          <Text style={styles.feedbackText}>{detail}</Text>
        </View>
        {level && (
          <View style={styles.feedbackRail}>
            <View
              style={[styles.feedbackProgress, { width: `${value * 100}%` }]}
            />
          </View>
        )}
      </VideoGlass>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  glyphShadow: { ...StyleSheet.absoluteFillObject, top: 1 },
  pill: { borderRadius: theme.radius.round },
  group: {
    borderRadius: theme.radius.round,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 2,
  },
  control: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.round,
  },
  largeControl: { width: 64, height: 64 },
  highlight: { backgroundColor: mediaMaterial.pressed },
  pressed: { transform: [{ scale: 0.94 }] },
  transport: {
    flexDirection: "row",
    direction: "ltr",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space.lg,
  },
  transportIcon: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  skip: { alignItems: "center", justifyContent: "center" },
  skipValue: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  skipTime: {
    includeFontPadding: false,
    ...theme.type.badge,
    fontSize: 10,
    lineHeight: 12,
    color: mediaMaterial.ink,
    fontVariant: ["tabular-nums"],
    textShadowColor: mediaMaterial.shade,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  feedbackPosition: {
    position: "absolute",
    alignSelf: "flex-start",
    top: "37%",
    zIndex: 8,
  },
  feedbackLeft: { left: theme.space.lg },
  feedbackRight: { right: theme.space.lg },
  speedPosition: { top: "22%" },
  feedback: {
    minWidth: 82,
    gap: theme.space.xs,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  feedbackLabel: {
    flexDirection: "row",
    direction: "ltr",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space.xs,
  },
  feedbackText: {
    ...theme.type.caption,
    fontWeight: "600",
    color: mediaMaterial.ink,
    fontVariant: ["tabular-nums"],
  },
  feedbackRail: {
    height: 3,
    borderRadius: theme.radius.round,
    backgroundColor: mediaMaterial.rail,
    overflow: "hidden",
    direction: "ltr",
  },
  feedbackProgress: {
    height: "100%",
    borderRadius: theme.radius.round,
    backgroundColor: mediaMaterial.accent,
  },
}));
