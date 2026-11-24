import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  cancelAnimation,
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "@/theme";
import { OpeningMark, openingMotion, openingPalette } from "./brand";

const AnimatedPath = Animated.createAnimatedComponent(Path);

function subscribeToForeground(listener: () => void) {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
}

function isForeground() {
  return AppState.currentState === "active";
}

export function useOpeningForeground() {
  return useSyncExternalStore(
    subscribeToForeground,
    isForeground,
    isForeground,
  );
}

// The contour is cut out of one opaque sheet. Only its rim and cover are drawn.
function aperture(width: number, height: number, progress: number) {
  "worklet";
  const x = width / 2;
  const y = height / 2;
  const radius = Math.hypot(x, y) * 1.24 * progress;
  const rx = radius * (1 + 0.14 * (1 - progress));
  const ry = radius * (1 - 0.31 * (1 - progress));
  const k = 0.69;
  return `M ${x + rx} ${y} C ${x + rx} ${y + k * ry} ${x + k * rx} ${y + ry} ${x} ${y + ry} C ${x - k * rx} ${y + ry} ${x - rx} ${y + k * ry} ${x - rx} ${y} C ${x - rx} ${y - k * ry} ${x - k * rx} ${y - ry} ${x} ${y - ry} C ${x + k * rx} ${y - ry} ${x + rx} ${y - k * ry} ${x + rx} ${y} Z`;
}

export function OpeningCurtain({
  revealing,
  handedOff,
  label,
  onDrawn,
  onRevealed,
}: {
  revealing: boolean;
  label: string;
  handedOff: boolean;
  onDrawn: () => void;
  onRevealed: () => void;
}) {
  const { theme, reduceMotion } = useTheme();
  const [palette] = useState(() => openingPalette[theme]);
  const { base, bright, edge } = palette;
  const active = useOpeningForeground();
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const progress = useSharedValue(0);
  const breath = useSharedValue(0);
  useEffect(() => {
    if (revealing || !handedOff || !active || reduceMotion) return;
    breath.set(
      withRepeat(
        withTiming(1, { duration: 1050, easing: openingMotion.unfold }),
        -1,
        true,
      ),
    );
    return () => cancelAnimation(breath);
  }, [active, breath, handedOff, reduceMotion, revealing]);
  useEffect(() => {
    if (!revealing || !handedOff || !width || !height || !active) return;
    progress.set(
      withTiming(
        1,
        {
          duration: reduceMotion
            ? openingMotion.reduced
            : Math.max(100, openingMotion.reveal * (1 - progress.get())),
          easing: openingMotion.unfold,
        },
        (finished) => {
          if (finished) scheduleOnRN(onRevealed);
        },
      ),
    );
    return () => cancelAnimation(progress);
  }, [
    active,
    handedOff,
    height,
    onRevealed,
    progress,
    reduceMotion,
    revealing,
    width,
  ]);

  const rect = `M 0 0 H ${width} V ${height} H 0 Z`;
  const cover = useAnimatedProps(() => ({
    d: reduceMotion
      ? rect
      : `${rect} ${aperture(width, height, progress.get())}`,
  }));
  const rim = useAnimatedProps(() => ({
    d: aperture(width, height, progress.get()),
    opacity: interpolate(
      progress.get(),
      [0, 0.17, 0.58, 1],
      [0, 0.86, 0.64, 0],
    ),
  }));
  const layer = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 1 - progress.get() : 1,
  }));
  const mark = useAnimatedStyle(() => ({
    opacity: reduceMotion
      ? 1
      : interpolate(progress.get(), [0, 0.19], [1, 0], "clamp"),
    transform: [
      {
        scale: reduceMotion
          ? 1
          : 1 + 0.045 * breath.get() + progress.get() * 0.22,
      },
      { scaleY: reduceMotion ? 1 : 1 - 0.19 * progress.get() },
    ],
  }));
  return (
    <Animated.View
      accessible
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
      style={[StyleSheet.absoluteFill, layer]}
      onLayout={({ nativeEvent: { layout } }) => setSize(layout)}
    >
      {width > 0 && height > 0 ? (
        <Svg width={width} height={height}>
          <Defs>
            <LinearGradient
              id="opening-rim"
              x1="20%"
              y1="92%"
              x2="87%"
              y2="18%"
            >
              <Stop offset={0} stopColor={bright} stopOpacity={0.15} />
              <Stop offset={0.48} stopColor={edge} />
              <Stop offset={1} stopColor={bright} stopOpacity={0.3} />
            </LinearGradient>
          </Defs>
          <AnimatedPath
            d={rect}
            animatedProps={cover}
            fill={base}
            fillRule="evenodd"
          />
          {!reduceMotion && (
            <AnimatedPath
              animatedProps={rim}
              stroke="url(#opening-rim)"
              strokeWidth={2}
              fill="none"
            />
          )}
        </Svg>
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: base }]} />
      )}
      <View style={styles.center} pointerEvents="none">
        <Animated.View style={mark}>
          <OpeningMark onDisplay={onDrawn} onError={onDrawn} />
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
});
