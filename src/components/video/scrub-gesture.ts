import { Gesture } from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

export function createScrubGesture({
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
  const drag = Gesture.Pan()
    .enabled(enabled)
    .minDistance(6)
    .onStart((event) => {
      const value = fraction(event.x);
      progress.set(value);
      active.set(true);
      scheduleOnRN(begin, value * duration);
    })
    .onUpdate((event) => {
      progress.set(fraction(event.x));
    })
    .onFinalize((event, success) => {
      if (!active.get()) return;
      if (success) {
        const value = fraction(event.x);
        playbackProgress.set(value);
        scheduleOnRN(finish, value * duration);
      } else {
        scheduleOnRN(finish);
      }
      active.set(false);
    });
  const tap = Gesture.Tap()
    .enabled(enabled)
    .maxDistance(6)
    .onEnd((event, success) => {
      if (success) scheduleOnRN(seek, fraction(event.x) * duration);
    });
  return Gesture.Race(drag, tap);
}
