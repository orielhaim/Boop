import { Platform } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import {
  clamp,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

export function useAnimateScrollView(imageHeight: number) {
  const reduceMotion = useReducedMotion();
  const android = Platform.OS === "android";
  const scrollY = useSharedValue(0);
  const drag = useSharedValue(0);
  const startedAtTop = useSharedValue(false);

  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  // Android stretches its edge effect without reporting negative scroll offsets.
  const pan = Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetX([-18, 18])
    .onBegin(() => {
      startedAtTop.value = scrollY.value <= 0;
    })
    .onUpdate(({ translationY }) => {
      if (startedAtTop.value && scrollY.value <= 0) {
        drag.value = clamp(translationY * 0.45, 0, imageHeight);
      } else {
        drag.value = 0;
      }
    })
    .onFinalize(() => {
      drag.value = withSpring(0, {
        damping: 22,
        stiffness: 260,
        overshootClamping: true,
      });
    });
  const androidGesture = Gesture.Simultaneous(Gesture.Native(), pan);

  const artwork = useAnimatedStyle(() => {
    const nativePull = reduceMotion ? 0 : Math.max(0, -scrollY.value);
    const stretch = android ? drag.value : nativePull;
    const parallax = reduceMotion
      ? 0
      : clamp(scrollY.value, 0, imageHeight) * 0.5;
    return {
      transform: [
        { translateY: parallax - nativePull },
        { scale: 1 + stretch / imageHeight },
      ],
    };
  });

  const body = useAnimatedStyle(() => ({
    transform: [{ translateY: android ? drag.value : 0 }],
  }));

  return { onScroll, artwork, body, androidGesture, android, reduceMotion };
}
