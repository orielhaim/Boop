import { useEffect, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import Svg, {
  Defs,
  Ellipse,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";
import { useTheme } from "@/theme";

// Adapted from Reacticx Aura Lift's rising color bands.
export function AuraLift({
  scope = "button",
}: {
  scope?: "button" | "profile";
}) {
  const { colors, theme } = useTheme();
  const { height } = useWindowDimensions();
  const [finished, setFinished] = useState(false);
  const progress = useSharedValue(0);
  const fullProfile = scope === "profile";

  useEffect(() => {
    progress.value = withTiming(
      1,
      { duration: 900, easing: Easing.linear },
      (completed) => {
        if (completed) scheduleOnRN(setFinished, true);
      },
    );
    return () => cancelAnimation(progress);
  }, [progress]);

  const lift = useAnimatedStyle(() => ({
    opacity: Math.sin(progress.value * Math.PI),
    transform: [
      {
        translateY: fullProfile
          ? height * (0.68 - progress.value * 1.36)
          : 44 - progress.value * 92,
      },
    ],
  }));

  if (finished) return null;
  const dark = theme === "dark";
  return (
    <View
      style={fullProfile ? styles.profileAura : styles.buttonAura}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[fullProfile ? styles.wave : StyleSheet.absoluteFill, lift]}
      >
        <Svg
          width="100%"
          height="100%"
          viewBox="0 0 200 96"
          preserveAspectRatio="none"
        >
          {fullProfile ? (
            <>
              <Defs>
                <LinearGradient id="wave" x1="0%" y1="0%" x2="100%" y2="0%">
                  <Stop offset="0" stopColor={dark ? "#859CFF" : "#6398CB"} />
                  <Stop
                    offset="0.55"
                    stopColor={dark ? "#BFCFFF" : "#94B0DB"}
                  />
                  <Stop offset="1" stopColor={dark ? "#B68FCB" : "#B88FB6"} />
                </LinearGradient>
              </Defs>
              {[48, 36, 25, 15, 7].map((width) => (
                <Path
                  key={width}
                  d="M -32 59 C 24 59 44 35 98 38 S 174 58 232 46"
                  fill="none"
                  stroke="url(#wave)"
                  strokeOpacity={dark ? 0.036 : 0.03}
                  strokeWidth={width}
                />
              ))}
            </>
          ) : (
            <>
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
            </>
          )}
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  buttonAura: {
    position: "absolute",
    bottom: -25,
    left: 0,
    right: 0,
    height: 96,
  },
  profileAura: { ...StyleSheet.absoluteFill, zIndex: 2, overflow: "hidden" },
  wave: { position: "absolute", left: 0, right: 0, top: "33%", height: "34%" },
});
