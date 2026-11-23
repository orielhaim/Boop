import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Defs,
  Ellipse,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";
import { useTheme } from "@/theme";

// Reacticx Aura Lift's rising color bands and ring, confined to the saved control.
export function AuraLift() {
  const { colors, theme } = useTheme();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(1, {
      duration: 900,
      easing: Easing.linear,
    });
    return () => cancelAnimation(progress);
  }, [progress]);

  const lift = useAnimatedStyle(() => ({
    opacity: Math.sin(progress.value * Math.PI),
    transform: [{ translateY: 44 - progress.value * 92 }],
  }));

  const dark = theme === "dark";
  return (
    <Animated.View style={[styles.aura, lift]} pointerEvents="none">
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 200 96"
        preserveAspectRatio="none"
      >
        <Defs>
          <RadialGradient id="cool" cx="36%" cy="52%" rx="64%" ry="48%">
            <Stop
              offset="0"
              stopColor={dark ? "#859CFF" : "#95CFFF"}
              stopOpacity={dark ? 0.38 : 0.72}
            />
            <Stop
              offset="1"
              stopColor={dark ? "#859CFF" : "#95CFFF"}
              stopOpacity={0}
            />
          </RadialGradient>
          <RadialGradient id="warm" cx="66%" cy="61%" rx="49%" ry="35%">
            <Stop
              offset="0"
              stopColor={dark ? "#CA88D2" : "#F8C3CD"}
              stopOpacity={dark ? 0.36 : 0.68}
            />
            <Stop
              offset="1"
              stopColor={dark ? "#CA88D2" : "#F8C3CD"}
              stopOpacity={0}
            />
          </RadialGradient>
        </Defs>
        <Rect width="200" height="96" fill="url(#cool)" />
        <Rect width="200" height="96" fill="url(#warm)" />
        <Ellipse
          cx="100"
          cy="68"
          rx="108"
          ry="30"
          fill="none"
          stroke={colors.accent}
          strokeOpacity={dark ? 0.48 : 0.34}
          strokeWidth="1.5"
        />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  aura: { position: "absolute", bottom: -25, left: 0, right: 0, height: 96 },
});
