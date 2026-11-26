import { GaussianBlurView } from "expo-backdrop";
import type { ReactNode } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  type AnimatedProps,
  type SharedValue,
} from "react-native-reanimated";

const AnimatedBlur = Animated.createAnimatedComponent(GaussianBlurView);

export function DockMorph({
  clarity,
  blur = 18,
  minScale,
  fade = true,
  reduceMotion,
  children,
  style,
  ...props
}: Omit<ViewProps, "style"> & {
  style?: AnimatedProps<ViewProps>["style"];
  clarity: SharedValue<number>;
  blur?: number;
  minScale: number;
  fade?: boolean;
  reduceMotion: boolean;
  children: ReactNode;
}) {
  const appearance = useAnimatedStyle(() => {
    const value = clarity.get();
    return {
      opacity: fade ? value : 1,
      transform: [
        { scale: reduceMotion ? 1 : minScale + (1 - minScale) * value },
      ],
    };
  });
  const animatedProps = useAnimatedProps(() => ({
    blurRadius: reduceMotion ? 0 : blur * (1 - clarity.get()),
  }));
  if (reduceMotion) {
    return (
      <Animated.View {...props} style={[style, appearance]}>
        {children}
      </Animated.View>
    );
  }
  return (
    <Animated.View {...props} style={[style, appearance]}>
      <AnimatedBlur animatedProps={animatedProps} style={styles.fill}>
        <View style={styles.fill}>{children}</View>
      </AnimatedBlur>
    </Animated.View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
