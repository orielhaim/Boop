import { TabSlot, type TabSlotProps } from "expo-router/ui";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { AppState, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  cancelAnimation,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { motion } from "@/theme/tokens";
import { useDockMotion } from "./dock-motion";
import { nextTabTravel, type TabFrame } from "./tab-travel";

export function DirectionalTabs({
  active,
  order,
  warmRoutes,
  style,
  reduceMotion,
}: {
  active: string | undefined;
  order: string[];
  warmRoutes: readonly string[];
  style: ViewStyle;
  reduceMotion: boolean;
}) {
  const frame = useSharedValue<TabFrame>({ to: active, sign: 1 });
  const progress = useSharedValue(1);
  const { pageIntent } = useDockMotion();
  const committed = useSharedValue(active);
  const foreground = useSharedValue(true);
  const ready = useSharedValue<readonly string[]>([]);
  const [warm, setWarm] = useState(false);

  useEffect(() => {
    const task = requestIdleCallback(() => setWarm(true));
    return () => cancelIdleCallback(task);
  }, []);

  useLayoutEffect(() => {
    scheduleOnUI(() => {
      "worklet";
      pageIntent.set(undefined);
      committed.set(active);
    });
  }, [active, committed, pageIntent]);

  useAnimatedReaction(
    () => {
      const instant = reduceMotion || !foreground.get();
      const requested = pageIntent.get();
      return {
        instant,
        to:
          !instant && requested && ready.get().includes(requested)
            ? requested
            : committed.get(),
      };
    },
    ({ to, instant }) => {
      const travel = nextTabTravel(
        frame.get(),
        progress.get(),
        to,
        order,
        instant,
      );
      if (travel.kind === "unchanged") return;
      cancelAnimation(progress);
      frame.set(travel.frame);
      progress.set(travel.kind === "settle" ? 1 : travel.start);
      if (travel.kind === "slide") progress.set(withSpring(1, motion.travel));
    },
  );
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      foreground.set(state === "active");
      if (state === "active") return;
      scheduleOnUI(() => {
        "worklet";
        pageIntent.set(undefined);
        cancelAnimation(progress);
        progress.set(1);
      });
    });
    return () => listener.remove();
  }, [foreground, pageIntent, progress]);

  const markReady = useCallback(
    (name: string) => {
      scheduleOnUI(() => {
        "worklet";
        if (!ready.get().includes(name)) ready.set([...ready.get(), name]);
      });
    },
    [ready],
  );

  const render = useCallback<NonNullable<TabSlotProps["renderFn"]>>(
    (descriptor, { isFocused, loaded }) => {
      const { name } = descriptor.route;
      if (
        !isFocused &&
        !(warm && warmRoutes.includes(name)) &&
        (!loaded || !order.includes(name))
      )
        return null;
      return (
        <TabScene
          key={descriptor.route.key}
          name={name}
          focused={isFocused}
          frame={frame}
          progress={progress}
          markReady={markReady}
        >
          {descriptor.render()}
        </TabScene>
      );
    },
    [frame, markReady, order, progress, warm, warmRoutes],
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
  markReady,
  children,
}: {
  name: string;
  focused: boolean;
  frame: SharedValue<TabFrame>;
  progress: SharedValue<number>;
  markReady: (name: string) => void;
  children: React.ReactNode;
}) {
  const motion = useAnimatedStyle(() => {
    const { from, to, sign } = frame.get();
    const value = progress.get();
    const incoming = to === name;
    const outgoing = from === name && value < 1;
    return {
      opacity: incoming || outgoing ? 1 : 0,
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
      onLayout={() => markReady(name)}
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
