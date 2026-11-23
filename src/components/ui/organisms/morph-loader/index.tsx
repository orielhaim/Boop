import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "@/theme";
import { STEPS_PER_SEGMENT, VIEWBOX } from "./const";
import { getMorphFrames } from "./helper";

const AnimatedPath = Animated.createAnimatedComponent(Path);

// Reacticx Morph Loader's shape sequence and easing, drawn with Boop's SVG renderer.
export function MorphLoader({
  size = 18,
  color,
}: {
  size?: number;
  color?: string;
}) {
  const { colors, reduceMotion } = useTheme();
  const frames = getMorphFrames();
  const frame = useSharedValue(0);
  const rotation = useSharedValue(0);

  useEffect(() => {
    frame.value = 0;
    rotation.value = 0;
    if (reduceMotion) return;
    frame.value = withRepeat(
      withTiming(frames.length, {
        duration: (frames.length / STEPS_PER_SEGMENT) * 650,
        easing: Easing.linear,
      }),
      -1,
    );
    rotation.value = withRepeat(
      withTiming(360, { duration: 5000, easing: Easing.linear }),
      -1,
    );
    return () => {
      cancelAnimation(frame);
      cancelAnimation(rotation);
    };
  }, [frame, frames.length, reduceMotion, rotation]);

  const path = useAnimatedProps(() => ({
    d: frames[Math.floor(frame.value) % frames.length],
  }));
  const spin = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: size, height: size }}
    >
      <Animated.View style={[styles.shape, spin]}>
        <Svg width="100%" height="100%" viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}>
          <AnimatedPath
            d={frames[0]}
            animatedProps={path}
            fill={color ?? colors.accent}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  shape: { ...StyleSheet.absoluteFill, margin: 2 },
});
