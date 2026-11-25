import { useEvent, useEventListener } from "expo";
import * as Brightness from "expo-brightness";
import type { VideoPlayer } from "expo-video";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, AppState, Platform } from "react-native";
import { updateVideoPlayer } from "@/core/video/player-settings";
import type { GestureValue } from "./media-controls";

export function useVideoControls(held: boolean) {
  const [requested, setRequested] = useState(true);
  const [revision, setRevision] = useState(0);
  const [screenReader, setScreenReader] = useState(false);

  useEffect(() => {
    let active = true;
    const subscription = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      setScreenReader,
    );
    void AccessibilityInfo.isScreenReaderEnabled().then((enabled) => {
      if (active) setScreenReader(enabled);
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  const reveal = useCallback(() => {
    setRequested(true);
    setRevision((value) => value + 1);
  }, []);
  const toggle = useCallback(() => setRequested((value) => !value), []);

  useEffect(() => {
    if (held || screenReader || !requested) return;
    const timer = setTimeout(() => setRequested(false), 3500);
    return () => clearTimeout(timer);
  }, [held, requested, revision, screenReader]);

  return {
    visible: held || screenReader || requested,
    screenReader,
    reveal,
    toggle,
  };
}

export function useVideoAppState() {
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
    });
    return () => subscription.remove();
  }, []);
  return foreground;
}

export function useVideoGestureFeedback(player: VideoPlayer, enabled: boolean) {
  const brightness = useRef(0.5);
  const originalBrightness = useRef<{ value: number; system: boolean } | null>(
    null,
  );
  const changedBrightness = useRef(false);
  const originalRate = useRef<number | undefined>(undefined);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const seekTotal = useRef(0);
  const [feedback, setFeedback] = useState<GestureValue>();
  const { playbackRate } = useEvent(player, "playbackRateChange", {
    playbackRate: player.playbackRate,
  });
  const [steadyRate, setSteadyRate] = useState<number>();
  const { muted } = useEvent(player, "mutedChange", { muted: player.muted });

  const show = useCallback((value: GestureValue, held = false) => {
    clearTimeout(feedbackTimer.current);
    setFeedback(value);
    if (!held)
      feedbackTimer.current = setTimeout(() => {
        setFeedback(undefined);
        seekTotal.current = 0;
      }, 740);
  }, []);

  const restoreRate = useCallback(() => {
    const rate = originalRate.current;
    if (rate === undefined) return;
    originalRate.current = undefined;
    updateVideoPlayer(player, { playbackRate: rate });
    setFeedback((value) => (value?.kind === "speed" ? undefined : value));
  }, [player]);

  useEventListener(player, "playbackRateChange", ({ playbackRate: rate }) => {
    if (originalRate.current === undefined) setSteadyRate(rate);
  });

  useEffect(
    () => () => {
      clearTimeout(feedbackTimer.current);
      const rate = originalRate.current;
      originalRate.current = undefined;
      if (rate !== undefined) updateVideoPlayer(player, { playbackRate: rate });
    },
    [player],
  );

  useEffect(() => {
    if (!enabled) {
      restoreRate();
      clearTimeout(feedbackTimer.current);
      return;
    }
    let active = true;
    void Promise.all([
      Brightness.getBrightnessAsync(),
      Platform.OS === "android"
        ? Brightness.isUsingSystemBrightnessAsync()
        : false,
    ])
      .then(([value, system]) => {
        if (!active) return;
        originalBrightness.current = { value, system };
        brightness.current = value;
      })
      .catch(() => undefined);
    return () => {
      active = false;
      const original = originalBrightness.current;
      originalBrightness.current = null;
      if (!original || !changedBrightness.current) return;
      changedBrightness.current = false;
      const restore = original.system
        ? Brightness.restoreSystemBrightnessAsync()
        : Brightness.setBrightnessAsync(original.value);
      void restore.catch(() => undefined);
    };
  }, [enabled, restoreRate]);

  const adjustBrightness = useCallback(
    (delta: number, held: boolean) => {
      if (!originalBrightness.current) return;
      const next = Math.max(0, Math.min(1, brightness.current + delta));
      if (next !== brightness.current) {
        brightness.current = next;
        changedBrightness.current = true;
        void Brightness.setBrightnessAsync(next).catch(() => undefined);
      }
      show({ kind: "brightness", value: next }, held);
    },
    [show],
  );
  const adjustVolume = useCallback(
    (delta: number, held: boolean) => {
      if (AppState.currentState !== "active") return;
      const current = player.volume;
      const next = Math.max(0, Math.min(1, current + delta));
      if (player.muted) updateVideoPlayer(player, { muted: false });
      if (next !== current) updateVideoPlayer(player, { volume: next });
      show({ kind: "volume", value: next }, held);
    },
    [player, show],
  );
  const temporaryRate = useCallback(
    (rate: number) => {
      if (originalRate.current === undefined) {
        originalRate.current = player.playbackRate;
        setSteadyRate(originalRate.current);
      }
      updateVideoPlayer(player, { playbackRate: rate });
      show({ kind: "speed", value: rate }, true);
    },
    [player, show],
  );
  const showSeek = useCallback(
    (delta: number) => {
      seekTotal.current =
        Math.sign(seekTotal.current) === Math.sign(delta)
          ? seekTotal.current + delta
          : delta;
      show({ kind: "seek", value: seekTotal.current });
    },
    [show],
  );

  return {
    feedback: enabled ? feedback : undefined,
    playbackRate: steadyRate ?? playbackRate,
    muted,
    adjustBrightness,
    adjustVolume,
    temporaryRate,
    restoreRate,
    showSeek,
  };
}
