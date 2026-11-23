import { Gesture } from "react-native-gesture-handler";
import {
  useDerivedValue,
  useSharedValue,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { vec } from "react-native-skia";

export function useRipple(enabled: boolean) {
  const origin = useSharedValue(vec(0, 0));
  const time = useSharedValue(0);
  const uniforms = useDerivedValue(() => ({
    u_origin: origin.value,
    u_time: time.value < 0.85 ? time.value : 0,
    u_amplitude: 10,
    u_frequency: 22,
    u_decay: 8,
    u_speed: 1200,
  }));
  const tap = Gesture.Tap()
    .enabled(enabled)
    .onStart(({ x, y }) => {
      origin.set(vec(x, y));
      time.set(0);
      time.set(withTiming(0.85, { duration: 850, easing: Easing.linear }));
    });
  return { uniforms, tap };
}
