import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  ReduceMotion,
  useAnimatedScrollHandler,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { useTheme } from "@/theme";
import { MORPH_SPRING } from "./dock-geometry";

type DockMotion = {
  minimized: SharedValue<number>;
  target: SharedValue<number>;
  profileProgress: SharedValue<number>;
  selectedIndex: SharedValue<number>;
  pageIntent: SharedValue<string | undefined>;
  slideTarget: SharedValue<number>;
  slideIndex: SharedValue<number>;
  dragging: SharedValue<boolean>;
  dragVelocity: SharedValue<number>;
};

const DockMotionContext = createContext<DockMotion | null>(null);

export function DockMinimizeProvider({ children }: { children: ReactNode }) {
  const minimized = useSharedValue(0);
  const target = useSharedValue(0);
  const profileProgress = useSharedValue(0);
  const selectedIndex = useSharedValue(0);
  const pageIntent = useSharedValue<string | undefined>(undefined);
  const slideTarget = useSharedValue(0);
  const slideIndex = useSharedValue(0);
  const dragging = useSharedValue(false);
  const dragVelocity = useSharedValue(0);
  const motion = useMemo(
    () => ({
      minimized,
      target,
      profileProgress,
      selectedIndex,
      pageIntent,
      slideTarget,
      slideIndex,
      dragging,
      dragVelocity,
    }),
    [
      dragging,
      dragVelocity,
      minimized,
      pageIntent,
      profileProgress,
      selectedIndex,
      slideIndex,
      slideTarget,
      target,
    ],
  );

  return (
    <DockMotionContext.Provider value={motion}>
      {children}
    </DockMotionContext.Provider>
  );
}

export function useDockMotion() {
  const motion = useContext(DockMotionContext);
  if (!motion) throw new Error("DockMinimizeProvider is missing");
  return motion;
}

export function useTabBarMinimized() {
  const motion = useContext(DockMotionContext);
  const fallback = useSharedValue(0);
  return motion?.minimized ?? fallback;
}

export const LENS_SPRING = { damping: 20, mass: 0.7, stiffness: 320 };

export function animateDockSelection(
  motion: Pick<DockMotion, "slideTarget" | "slideIndex">,
  index: number,
  reduceMotion: boolean,
  velocity?: number,
) {
  "worklet";
  if (velocity === undefined && motion.slideTarget.get() === index) return;
  motion.slideTarget.set(index);
  motion.slideIndex.set(
    reduceMotion
      ? index
      : withSpring(index, {
          ...LENS_SPRING,
          damping: 28,
          overshootClamping: true,
          velocity,
        }),
  );
}

export function setMinimized(
  motion: Pick<DockMotion, "minimized" | "target">,
  next: 0 | 1,
  reduceMotion: boolean,
) {
  "worklet";
  if (motion.target.get() === next) return;
  motion.target.set(next);
  motion.minimized.set(
    withSpring(next, {
      ...MORPH_SPRING,
      reduceMotion: reduceMotion ? ReduceMotion.Always : ReduceMotion.System,
    }),
  );
}

export function useMinimizeOnScroll() {
  const contextMotion = useContext(DockMotionContext);
  const hasDock = contextMotion !== null;
  const fallbackMinimized = useSharedValue(0);
  const fallbackTarget = useSharedValue(0);
  const motion = contextMotion ?? {
    minimized: fallbackMinimized,
    target: fallbackTarget,
  };
  const { reduceMotion } = useTheme();
  const previousY = useSharedValue(0);

  return useAnimatedScrollHandler({
    onScroll: (event) => {
      if (!hasDock) return;
      const maxY = Math.max(
        event.contentSize.height - event.layoutMeasurement.height,
        0,
      );
      const y = Math.min(Math.max(event.contentOffset.y, 0), maxY);
      const dy = y - previousY.get();
      previousY.set(y);

      if (y < 24) {
        setMinimized(motion, 0, reduceMotion);
      } else if (dy > 3) {
        setMinimized(motion, 1, reduceMotion);
      } else if (dy < -3) {
        setMinimized(motion, 0, reduceMotion);
      }
    },
  });
}
