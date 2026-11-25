import { useMemo } from "react";
import { Gesture } from "react-native-gesture-handler";
import {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

export function useSurfaceGestures({
  enabled,
  reduceMotion,
  width,
  height,
  toggleControls,
  close,
  minimize,
  seek,
  adjustBrightness,
  adjustVolume,
  temporaryRate,
  restoreRate,
}: {
  enabled: boolean;
  reduceMotion: boolean;
  width: number;
  height: number;
  toggleControls(): void;
  close(): void;
  minimize?: () => void;
  seek(seconds: number, accumulate?: boolean): void;
  adjustBrightness(delta: number, active: boolean): void;
  adjustVolume(delta: number, active: boolean): void;
  temporaryRate(rate: number): void;
  restoreRate(): void;
}) {
  const scale = useSharedValue(1);
  const scaleAtStart = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const xAtStart = useSharedValue(0);
  const yAtStart = useSharedValue(0);
  const center = useSharedValue(false);
  const atRight = useSharedValue(false);
  const holdX = useSharedValue(0);
  const holdY = useSharedValue(0);
  const held = useSharedValue(false);
  const holdStep = useSharedValue(0);
  const swipeY = useSharedValue(0);
  const pinching = useSharedValue(false);
  const panAction = useSharedValue<"seek" | "dismiss" | "level" | null>(null);
  const lastLevelY = useSharedValue(0);
  const latestLevelY = useSharedValue(0);
  const lastLevelAt = useSharedValue(0);

  const gesture = useMemo(() => {
    const tap = Gesture.Tap().onEnd((_, success) => {
      if (success) scheduleOnRN(toggleControls);
    });
    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDelay(240)
      .onEnd(({ x }, success) => {
        if (success) scheduleOnRN(seek, x < width / 2 ? -10 : 10, true);
      });
    if (!enabled) return tap;

    const pinch = Gesture.Pinch()
      .onStart(() => {
        pinching.set(true);
        scaleAtStart.set(scale.get());
      })
      .onUpdate((event) => {
        scale.set(Math.max(1, Math.min(3, scaleAtStart.get() * event.scale)));
        if (scale.get() <= 1) {
          x.set(0);
          y.set(0);
        }
      })
      .onFinalize(() => {
        pinching.set(false);
      });

    const pan = Gesture.Pan()
      .maxPointers(1)
      .minDistance(18)
      .onBegin((event) => {
        panAction.set(null);
        lastLevelY.set(0);
        latestLevelY.set(0);
        lastLevelAt.set(0);
        center.set(event.x >= width * 0.31 && event.x <= width * 0.69);
        atRight.set(event.x > width / 2);
        xAtStart.set(x.get());
        yAtStart.set(y.get());
      })
      .onUpdate((event) => {
        if (pinching.get()) return;
        if (scale.get() > 1) {
          const xBound = ((scale.get() - 1) * width) / 2;
          const yBound = ((scale.get() - 1) * height) / 2;
          x.set(
            Math.max(
              -xBound,
              Math.min(xBound, xAtStart.get() + event.translationX),
            ),
          );
          y.set(
            Math.max(
              -yBound,
              Math.min(yBound, yAtStart.get() + event.translationY),
            ),
          );
          return;
        }
        const action =
          panAction.get() ??
          (Math.abs(event.translationX) > Math.abs(event.translationY)
            ? "seek"
            : center.get()
              ? "dismiss"
              : "level");
        panAction.set(action);
        if (action === "dismiss") {
          swipeY.set(reduceMotion ? 0 : event.translationY);
        } else if (action === "level") {
          latestLevelY.set(event.translationY);
          // eslint-disable-next-line react-hooks/purity -- This callback runs on gesture input.
          const now = Date.now();
          if (now - lastLevelAt.get() < 32) return;
          const delta = (lastLevelY.get() - event.translationY) / 420;
          lastLevelAt.set(now);
          lastLevelY.set(event.translationY);
          scheduleOnRN(
            atRight.get() ? adjustVolume : adjustBrightness,
            delta,
            true,
          );
        }
      })
      .onEnd((event, success) => {
        if (!success || pinching.get() || scale.get() > 1) return;
        if (panAction.get() === "seek") {
          scheduleOnRN(seek, Math.round(event.translationX / 6));
        } else if (panAction.get() === "dismiss") {
          if (event.translationY > 120) scheduleOnRN(close);
          else if (event.translationY < -120 && minimize)
            scheduleOnRN(minimize);
        }
      })
      .onFinalize((_, success) => {
        if (panAction.get() === "level") {
          const delta =
            success && !pinching.get() && scale.get() === 1
              ? (lastLevelY.get() - latestLevelY.get()) / 420
              : 0;
          scheduleOnRN(
            atRight.get() ? adjustVolume : adjustBrightness,
            delta,
            false,
          );
        }
        swipeY.set(
          reduceMotion ? 0 : withSpring(0, { damping: 23, stiffness: 240 }),
        );
      });

    const hold = Gesture.LongPress()
      .minDuration(250)
      .maxDistance(10000)
      .onTouchesDown((event, handler) => {
        const start = event.allTouches[0];
        if (!start || start.x < width * 0.62) {
          handler.fail();
          return;
        }
        holdX.set(start.absoluteX);
        holdY.set(start.absoluteY);
      })
      .onStart(() => {
        if (pinching.get()) return;
        held.set(true);
        holdStep.set(0);
        scheduleOnRN(temporaryRate, 2);
      })
      .onTouchesMove((event, handler) => {
        const touch = event.allTouches[0];
        if (!touch) return;
        const deltaX = touch.absoluteX - holdX.get();
        if (!held.get()) {
          if (
            Math.max(
              Math.abs(deltaX),
              Math.abs(touch.absoluteY - holdY.get()),
            ) > 8
          )
            handler.fail();
          return;
        }
        const step = Math.max(0, Math.min(5, Math.round(deltaX / 20)));
        if (step === holdStep.get()) return;
        holdStep.set(step);
        scheduleOnRN(temporaryRate, 2 + step / 10);
      })
      .onFinalize(() => {
        if (!held.get()) return;
        held.set(false);
        scheduleOnRN(restoreRate);
      });

    return Gesture.Simultaneous(
      pinch,
      Gesture.Race(hold, pan, Gesture.Exclusive(doubleTap, tap)),
    );
  }, [
    adjustBrightness,
    adjustVolume,
    atRight,
    center,
    close,
    enabled,
    held,
    height,
    holdStep,
    holdX,
    holdY,
    lastLevelAt,
    lastLevelY,
    latestLevelY,
    minimize,
    panAction,
    pinching,
    reduceMotion,
    restoreRate,
    scale,
    scaleAtStart,
    seek,
    swipeY,
    temporaryRate,
    toggleControls,
    width,
    x,
    xAtStart,
    y,
    yAtStart,
  ]);

  const surfaceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: swipeY.get() }],
  }));
  const videoStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.get() },
      { translateY: y.get() },
      { scale: scale.get() },
    ],
  }));
  return { gesture, surfaceStyle, videoStyle };
}
