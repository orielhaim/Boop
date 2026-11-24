import { TabSlot, type TabSlotProps } from "expo-router/ui";
import { useCallback, useEffect, useLayoutEffect } from "react";
import { AppState, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  cancelAnimation,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { motion } from "@/theme/tokens";
import { nextTabTravel, type TabFrame } from "./tab-travel";

export function DirectionalTabs({
  active,
  order,
  style,
  reduceMotion,
}: {
  active: string | undefined;
  order: string[];
  style: ViewStyle;
  reduceMotion: boolean;
}) {
  const frame = useSharedValue<TabFrame>({ to: active, sign: 1 });
  const progress = useSharedValue(1);

  useLayoutEffect(() => {
    const currentState = AppState.currentState;
    const instant =
      reduceMotion || (currentState != null && currentState !== "active");
    scheduleOnUI(() => {
      "worklet";
      const travel = nextTabTravel(
        frame.get(),
        progress.get(),
        active,
        order,
        instant,
      );
      if (travel.kind === "unchanged") return;
      cancelAnimation(progress);
      frame.set(travel.frame);
      progress.set(travel.kind === "settle" ? 1 : travel.start);
      if (travel.kind === "slide") progress.set(withSpring(1, motion.travel));
    });
  }, [active, frame, order, progress, reduceMotion]);

  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      scheduleOnUI(() => {
        "worklet";
        cancelAnimation(progress);
        progress.set(1);
      });
    });
    return () => listener.remove();
  }, [progress]);

  const render = useCallback<NonNullable<TabSlotProps["renderFn"]>>(
    (descriptor, { isFocused, loaded }) => {
      const { name } = descriptor.route;
      if (!isFocused && (!loaded || !order.includes(name))) return null;
      return (
        <TabScene
          key={descriptor.route.key}
          name={name}
          focused={isFocused}
          frame={frame}
          progress={progress}
        >
          {descriptor.render()}
        </TabScene>
      );
    },
    [frame, order, progress],
  );

  return (
    <TabSlot
      detachInactiveScreens={false}
      renderFn={render}
      style={[styles.clip, style]}
    />
  );
}

function TabScene({
  name,
  focused,
  frame,
  progress,
  children,
}: {
  name: string;
  focused: boolean;
  frame: SharedValue<TabFrame>;
  progress: SharedValue<number>;
  children: React.ReactNode;
}) {
  const motion = useAnimatedStyle(() => {
    const { from, to, sign } = frame.get();
    const value = progress.get();
    const incoming = to === name;
    const outgoing = from === name && value < 1;
    return {
      display: incoming || outgoing ? "flex" : "none",
      transform: [
        {
          translateX: `${sign * (incoming ? 1 - value : -value) * 100}%`,
        },
      ],
    };
  });
  return (
    <Animated.View
      pointerEvents={focused ? "auto" : "none"}
      accessibilityElementsHidden={!focused}
      importantForAccessibility={focused ? "auto" : "no-hide-descendants"}
      style={[StyleSheet.absoluteFill, motion]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
});
