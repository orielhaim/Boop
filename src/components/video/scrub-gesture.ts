import {
  useCompetingGestures,
  usePanGesture,
  useTapGesture,
} from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

export function useScrubGesture({
  duration,
  railWidth,
  progress,
  playbackProgress,
  active,
  begin,
  seek,
  finish,
}: {
  duration: number;
  railWidth: SharedValue<number>;
  progress: SharedValue<number>;
  playbackProgress: SharedValue<number>;
  active: SharedValue<boolean>;
  begin(seconds: number): void;
  seek(seconds: number): void;
  finish(seconds?: number): void;
}) {
  const fraction = (x: number) => {
    "worklet";
    return Math.max(0, Math.min(1, x / railWidth.get()));
  };
  const enabled = Number.isFinite(duration) && duration > 0;
  const drag = usePanGesture({
    enabled,
    minDistance: 6,
    onActivate: (event) => {
      const value = fraction(event.x);
      progress.set(value);
      active.set(true);
      scheduleOnRN(begin, value * duration);
    },
    onUpdate: (event) => {
      progress.set(fraction(event.x));
    },
    onDeactivate: (event) => {
      if (!event.canceled) {
        const value = fraction(event.x);
        playbackProgress.set(value);
        scheduleOnRN(finish, value * duration);
      } else {
        scheduleOnRN(finish);
      }
      active.set(false);
    },
  });
  const tap = useTapGesture({
    enabled,
    maxDistance: 6,
    onDeactivate: (event) => {
      if (!event.canceled) scheduleOnRN(seek, fraction(event.x) * duration);
    },
  });
  return useCompetingGestures(drag, tap);
}
