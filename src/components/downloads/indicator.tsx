import { router } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { Icon, Ink, tapFeedback } from "@/components/ui/kit";
import { useLocal } from "@/services/local-context";
import { useTheme } from "@/theme";

const Ring = Animated.createAnimatedComponent(Circle);
const radius = 16;
const perimeter = 2 * Math.PI * radius;

export function DownloadsIndicator() {
  const { downloads } = useLocal();
  const { t, i18n } = useTranslation("downloads");
  const { colors, reduceMotion } = useTheme();
  const { count, selected } = useSyncExternalStore(
    downloads.subscribe,
    downloads.indicator,
  );
  const selectedId = selected?.id;
  const [shown, setShown] = useState(selectedId);
  const last = useSyncExternalStore(downloads.subscribe, () =>
    shown ? downloads.get(shown) : undefined,
  );
  const finishing =
    !reduceMotion && last?.state === "completed" && shown !== selectedId;
  const displayed = finishing ? last : selected;
  const displayedId = displayed?.id;

  useEffect(() => {
    if (shown === selectedId) return;
    const timer = setTimeout(() => setShown(selectedId), finishing ? 280 : 0);
    return () => clearTimeout(timer);
  }, [finishing, selectedId, shown]);

  const visible = Boolean(selected || finishing);
  const unknown =
    displayed?.state === "active" &&
    !displayed.total &&
    displayed.nativeState === "downloading";
  const paused = displayed?.state === "paused";
  const waiting =
    displayed?.state === "waiting" ||
    displayed?.nativeState === "retry_scheduled";
  const status = paused ? t("paused") : waiting ? t("waiting") : null;
  const fraction = finishing
    ? 1
    : displayed?.total
      ? Math.min(0.99, displayed.received / displayed.total)
      : unknown
        ? 0.16
        : 0;
  const width = useSharedValue(visible ? 46 : 0);
  const fill = useSharedValue(0);
  const spin = useSharedValue(0);
  const previousId = useRef(displayedId);
  const shownWidth = useAnimatedStyle(() => ({
    width: width.value,
    opacity: width.value / 46,
  }));
  const rotation = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value}deg` }],
  }));
  const arc = useAnimatedProps(() => ({
    strokeDashoffset: perimeter * (1 - fill.value),
  }));

  useEffect(() => {
    width.set(
      withTiming(visible ? 46 : 0, { duration: reduceMotion ? 0 : 180 }),
    );
  }, [reduceMotion, visible, width]);
  useEffect(() => {
    if (previousId.current !== displayedId) fill.set(0);
    previousId.current = displayedId;
    fill.set(
      withTiming(fraction, {
        duration: reduceMotion ? 0 : 240,
        easing: Easing.out(Easing.cubic),
      }),
    );
  }, [displayedId, fill, fraction, reduceMotion]);
  useEffect(() => {
    spin.set(0);
    if (unknown && !reduceMotion)
      spin.set(
        withRepeat(
          withTiming(360, { duration: 1_100, easing: Easing.linear }),
          -1,
        ),
      );
    return () => cancelAnimation(spin);
  }, [reduceMotion, spin, unknown]);

  return (
    <Animated.View
      style={[styles.slot, shownWidth]}
      pointerEvents={count ? "auto" : "none"}
    >
      <Pressable
        accessible={count > 0}
        accessibilityRole="button"
        accessibilityLabel={[t("indicator", { count }), status]
          .filter(Boolean)
          .join(". ")}
        accessibilityValue={
          displayed?.total
            ? { min: 0, max: 100, now: Math.round(fraction * 100) }
            : undefined
        }
        onPress={() => {
          tapFeedback();
          router.push("/downloads");
        }}
        style={styles.button}
      >
        <Animated.View style={[styles.ring, rotation]}>
          <Svg width={38} height={38}>
            <Circle
              cx={19}
              cy={19}
              r={radius}
              stroke={colors.line}
              strokeWidth={2}
              fill="none"
            />
            <Ring
              cx={19}
              cy={19}
              r={radius}
              stroke={colors.accent}
              strokeWidth={2}
              strokeLinecap="round"
              fill="none"
              strokeDasharray={[perimeter, perimeter]}
              rotation={-90}
              origin="19,19"
              animatedProps={arc}
            />
          </Svg>
        </Animated.View>
        <Icon
          name={
            finishing
              ? "check"
              : paused
                ? "pause"
                : waiting
                  ? "refresh"
                  : "download"
          }
          size={18}
        />
        {count > 1 && (
          <View
            style={[
              styles.badge,
              {
                backgroundColor: colors.outgoing,
                borderColor: colors.background,
              },
            ]}
          >
            <Ink
              style={[styles.count, { color: colors.outgoingInk }]}
              maxFontSizeMultiplier={1.25}
            >
              {new Intl.NumberFormat(i18n.language).format(Math.min(99, count))}
              {count > 99 ? "+" : ""}
            </Ink>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  slot: { width: 0, height: 46, overflow: "hidden" },
  button: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: { position: "absolute" },
  badge: {
    position: "absolute",
    top: 1,
    end: 0,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 2,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  count: {
    fontSize: 9,
    fontWeight: "700",
    lineHeight: 12,
    fontVariant: ["tabular-nums"],
  },
});
