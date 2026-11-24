import { useEffect, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { useTheme } from "@/theme";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const strokeWidth = 2.5;

export function DownloadProgressRing({
  children,
  fraction = 0,
  indeterminate = false,
  size = 42,
}: {
  children: ReactNode;
  fraction?: number;
  indeterminate?: boolean;
  size?: number;
}) {
  const { colors, reduceMotion } = useTheme();
  const center = size / 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const inset = 2 * (strokeWidth + 2);
  const inner = size - inset;
  const target = indeterminate ? 0.22 : Math.max(0, Math.min(1, fraction));
  const progress = useSharedValue(target);
  const angle = useSharedValue(0);

  const arc = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - progress.value),
    opacity: progress.value > 0 ? 1 : 0,
  }));
  const rotation = useAnimatedStyle(() => ({
    transform: [{ rotate: `${angle.value}deg` }],
  }));

  useEffect(() => {
    progress.set(
      withTiming(target, {
        duration: reduceMotion ? 0 : 220,
        easing: Easing.out(Easing.cubic),
      }),
    );
  }, [progress, reduceMotion, target]);

  useEffect(() => {
    angle.set(0);
    if (indeterminate && !reduceMotion)
      angle.set(
        withRepeat(
          withTiming(360, { duration: 1100, easing: Easing.linear }),
          -1,
        ),
      );
    return () => cancelAnimation(angle);
  }, [angle, indeterminate, reduceMotion]);

  return (
    <View
      pointerEvents="none"
      style={[styles.center, { width: size, height: size }]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, rotation]}>
        <Svg width={size} height={size}>
          <Circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={colors.line}
            strokeWidth={strokeWidth}
          />
          <AnimatedCircle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={colors.accent}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={[circumference, circumference]}
            rotation={-90}
            originX={center}
            originY={center}
            animatedProps={arc}
          />
        </Svg>
      </Animated.View>
      <View
        style={[
          styles.center,
          {
            width: inner,
            height: inner,
            borderRadius: inner / 2,
            backgroundColor: colors.selected,
          },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
});
