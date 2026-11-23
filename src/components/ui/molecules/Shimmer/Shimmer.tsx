import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

// Adapted from Reacticx Shimmer. Shapes in the same skeleton share one sweep.
export function useShimmerProgress(active: boolean) {
  const progress = useSharedValue(0);
  useEffect(() => {
    if (!active) return;
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: 1500, easing: Easing.linear }),
      -1,
    );
    return () => cancelAnimation(progress);
  }, [active, progress]);
  return progress;
}

export function Shimmer({
  background,
  highlight,
  progress,
  rtl,
  style,
}: {
  background: string;
  highlight: string;
  progress?: SharedValue<number>;
  rtl: boolean;
  style: ViewStyle;
}) {
  const [width, setWidth] = useState(0);
  const waveWidth = width * 0.5;
  const wave = useAnimatedStyle(() => {
    const position = (progress?.value ?? 0) * (width + waveWidth);
    return {
      transform: [
        { translateX: rtl ? width - position : position - waveWidth },
      ],
    };
  });

  return (
    <View
      style={[styles.shape, style, { backgroundColor: background }]}
      onLayout={
        progress
          ? ({ nativeEvent }) => setWidth(nativeEvent.layout.width)
          : undefined
      }
    >
      {progress && width > 0 && (
        <Animated.View style={[styles.wave, { width: waveWidth }, wave]}>
          <LinearGradient
            colors={[background, highlight, background]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  shape: { overflow: "hidden" },
  wave: { position: "absolute", top: 0, bottom: 0, left: 0 },
});
