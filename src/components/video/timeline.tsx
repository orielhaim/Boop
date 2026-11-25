import { useEventListener } from "expo";
import { Image } from "expo-image";
import type { VideoPlayer, VideoThumbnail } from "expo-video";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AppState,
  Platform,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { scheduleOnRN } from "react-native-worklets";
import { tapFeedback } from "@/components/ui/kit";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { mediaMaterial } from "@/theme/tokens";
import { updateVideoPlayer } from "@/core/video/player-settings";
import { notifySubtitleSeek } from "@/core/video/subtitles/sync";
import { createScrubGesture } from "./scrub-gesture";
import { createScrubPreview } from "./scrub-preview";

export const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  const clock = `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
};

export function useVideoTimeline({
  player,
  reduceMotion,
  isPlaying,
  reveal,
  onMemoryWarning,
  scrubbing,
  setScrubbing,
}: {
  player: VideoPlayer;
  reduceMotion: boolean;
  isPlaying: boolean;
  reveal: () => void;
  scrubbing: boolean;
  setScrubbing: (active: boolean) => void;
  onMemoryWarning?: (listener: () => void) => () => void;
}) {
  const duration = player.duration;
  const [previewThumbnail, setPreviewThumbnail] = useState<VideoThumbnail>();
  const [previewPainted, setPreviewPainted] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);
  const [committedTime, setCommittedTime] = useState<number>();
  const pendingSeek = useRef<number | undefined>(undefined);
  const scrubPlayback = useRef<{ wasPlaying: boolean } | null>(null);
  const railWidthValue = useSharedValue(1);
  const progressValue = useSharedValue(0);
  const scrubProgress = useSharedValue(0);
  const scrubActive = useSharedValue(false);
  const lastPreviewProgress = useSharedValue(-1);
  const lastPreviewAt = useSharedValue(0);
  const [currentTime, setCurrentTime] = useState(() => player.currentTime);
  const time = scrubbing ? scrubTime : (committedTime ?? currentTime);
  const fraction = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;
  const buffered =
    duration > 0
      ? Math.max(0, Math.min(1, player.bufferedPosition / duration))
      : 0;
  const previews = useMemo(
    () =>
      createScrubPreview(
        async (time) => {
          if (Platform.OS === "web") return;
          if (player.generateScrubThumbnailAsync)
            return player.generateScrubThumbnailAsync(time);
          const [frame] = await player.generateThumbnailsAsync(time, {
            maxWidth: 184,
            maxHeight: 104,
          });
          return frame;
        },
        setPreviewThumbnail,
        () => {
          try {
            player.releaseScrubThumbnailExtractor?.();
          } catch {
            // The protected playback session can release the player first.
          }
        },
      ),
    [player],
  );
  useEffect(
    () =>
      onMemoryWarning?.(() => {
        previews.clear();
        setPreviewThumbnail(undefined);
        setPreviewPainted(false);
      }),
    [onMemoryWarning, previews],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") return;
      previews.clear();
      scrubPlayback.current = null;
      scrubActive.set(false);
      setPreviewVisible(false);
      setPreviewThumbnail(undefined);
      setPreviewPainted(false);
      setScrubbing(false);
    });
    return () => subscription.remove();
  }, [previews, scrubActive, setScrubbing]);

  useEventListener(player, "timeUpdate", ({ currentTime: sample }) => {
    const target = pendingSeek.current;
    if (target === undefined) {
      setCurrentTime(sample);
      return;
    }
    // Queued time events can still carry the pre-seek position. Confirm against
    // the native clock before handing off from the selected position.
    const position = player.currentTime;
    const confirmed = Math.min(position, Math.max(target, sample));
    if (position < target - 0.002 || confirmed > target + 0.75) return;
    pendingSeek.current = undefined;
    setCurrentTime(Math.max(target, confirmed));
    setCommittedTime(undefined);
  });

  useEventListener(player, "playToEnd", () => {
    if (pendingSeek.current === undefined) return;
    pendingSeek.current = undefined;
    setCurrentTime(player.currentTime);
    setCommittedTime(undefined);
  });

  useEffect(() => {
    if (!scrubbing) return;
    const timeout = setTimeout(() => setPreviewVisible(true), 150);
    return () => clearTimeout(timeout);
  }, [scrubbing]);

  useEffect(() => {
    if (
      !scrubbing &&
      committedTime === undefined &&
      pendingSeek.current === undefined
    ) {
      progressValue.set(
        reduceMotion
          ? fraction
          : withTiming(fraction, {
              duration: isPlaying ? 250 : 0,
              easing: Easing.linear,
            }),
      );
    }
  }, [
    committedTime,
    fraction,
    isPlaying,
    progressValue,
    reduceMotion,
    scrubbing,
  ]);

  useEffect(
    () => () => {
      scrubPlayback.current = null;
      previews.clear();
    },
    [previews],
  );

  const onRailLayout = useCallback(
    (event: LayoutChangeEvent) => {
      railWidthValue.set(Math.max(1, event.nativeEvent.layout.width));
    },
    [railWidthValue],
  );

  const updateScrub = useCallback(
    (seconds: number) => {
      if (!scrubPlayback.current) return;
      setScrubTime(seconds);
      // Some extractors cannot return a frame at the exact end of the asset.
      previews.request(Math.max(0, Math.min(seconds, duration - 0.001)));
    },
    [duration, previews],
  );

  useFrameCallback(({ timestamp }) => {
    if (!scrubActive.get()) return;
    const fraction = scrubProgress.get();
    if (
      lastPreviewProgress.get() === fraction ||
      timestamp - lastPreviewAt.get() < 40
    )
      return;
    lastPreviewAt.set(timestamp);
    lastPreviewProgress.set(fraction);
    scheduleOnRN(updateScrub, fraction * duration);
  });

  const beginScrub = useCallback(
    (seconds: number) => {
      if (AppState.currentState !== "active") return;
      scrubPlayback.current = { wasPlaying: player.playing };
      setPreviewVisible(false);
      player.pause();
      reveal();
      setScrubbing(true);
      updateScrub(seconds);
    },
    [player, reveal, setScrubbing, updateScrub],
  );

  const commitSeek = useCallback(
    (seconds: number, resume = true) => {
      if (AppState.currentState !== "active") return;
      reveal();
      pendingSeek.current = seconds;
      setCommittedTime(seconds);
      if (duration > 0) progressValue.set(seconds / duration);
      updateVideoPlayer(player, { currentTime: seconds });
      notifySubtitleSeek(player);
      if (resume) player.play();
    },
    [duration, player, progressValue, reveal],
  );

  const finishScrub = useCallback(
    (seconds?: number) => {
      const playback = scrubPlayback.current;
      scrubPlayback.current = null;
      previews.stop();
      setPreviewThumbnail(undefined);
      setPreviewPainted(false);
      setScrubbing(false);
      if (!playback || AppState.currentState !== "active") return;
      if (seconds !== undefined) {
        tapFeedback();
        commitSeek(seconds);
      } else if (playback.wasPlaying) player.play();
    },
    [commitSeek, player, previews, setScrubbing],
  );

  const seekBy = useCallback(
    (delta: number) => {
      if (!Number.isFinite(duration) || duration <= 0) return;
      const base = pendingSeek.current ?? player.currentTime;
      commitSeek(Math.max(0, Math.min(duration, base + delta)), false);
    },
    [commitSeek, duration, player],
  );
  const progressStyle = useAnimatedStyle(() => ({
    width: `${(scrubActive.get() ? scrubProgress.get() : progressValue.get()) * 100}%`,
  }));
  const thumbPositionStyle = useAnimatedStyle(() => ({
    left: `${(scrubActive.get() ? scrubProgress.get() : progressValue.get()) * 100}%`,
  }));
  const previewPositionStyle = useAnimatedStyle(() => {
    const width = railWidthValue.get();
    const halfPreview = Math.min(62, width / 2);
    const position = Math.max(
      halfPreview,
      Math.min(width - halfPreview, scrubProgress.get() * width),
    );
    return { transform: [{ translateX: position }] };
  });

  const scrubGesture = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- Gesture Handler registers these callbacks here and invokes them on input.
      createScrubGesture({
        duration,
        railWidth: railWidthValue,
        progress: scrubProgress,
        playbackProgress: progressValue,
        active: scrubActive,
        begin: beginScrub,
        seek: commitSeek,
        finish: finishScrub,
      }),
    [
      beginScrub,
      commitSeek,
      duration,
      finishScrub,
      progressValue,
      railWidthValue,
      scrubActive,
      scrubProgress,
    ],
  );

  const railEmphasis = useAnimatedStyle(() => {
    const active = scrubActive.get();
    return {
      transform: [
        {
          scaleY: reduceMotion
            ? active
              ? 1.6
              : 1
            : withTiming(active ? 1.6 : 1, { duration: 130 }),
        },
      ],
    };
  });
  const thumbEmphasis = useAnimatedStyle(() => {
    const scale = scrubActive.get() ? 1.4 : 1;
    return {
      transform: [
        { scale: reduceMotion ? scale : withTiming(scale, { duration: 130 }) },
      ],
    };
  });

  return {
    time,
    duration,
    scrubbing,
    buffered,
    progressStyle,
    thumbPositionStyle,
    previewPositionStyle,
    previewThumbnail,
    previewVisible,
    previewPainted,
    setPreviewPainted,
    scrubGesture,
    onRailLayout,
    seekBy,
    commitSeek,
    railEmphasis,
    thumbEmphasis,
  };
}

type Timeline = ReturnType<typeof useVideoTimeline>;

export function VideoTimeline({
  timeline,
  seekInterval,
}: {
  timeline: Timeline;
  seekInterval: number;
}) {
  const { t } = useTranslation("video");
  const {
    time,
    duration,
    scrubbing,
    buffered,
    progressStyle,
    thumbPositionStyle,
    previewPositionStyle,
    previewThumbnail,
    previewVisible,
    previewPainted,
    setPreviewPainted,
    scrubGesture,
    onRailLayout,
    seekBy,
    railEmphasis,
    thumbEmphasis,
  } = timeline;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return (
    <GestureDetector gesture={scrubGesture}>
      <View
        onLayout={onRailLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t("viewer.timeline")}
        accessibilityValue={{
          min: 0,
          max: Math.floor(duration),
          now: Math.floor(time),
          text: formatTime(time),
        }}
        accessibilityActions={[
          {
            name: "increment",
            label: t("viewer.seekForward", { seconds: seekInterval }),
          },
          {
            name: "decrement",
            label: t("viewer.seekBack", { seconds: seekInterval }),
          },
        ]}
        onAccessibilityAction={({ nativeEvent }) =>
          seekBy(
            nativeEvent.actionName === "increment"
              ? seekInterval
              : -seekInterval,
          )
        }
        style={styles.railHit}
      >
        {scrubbing && previewVisible ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.preview, previewPositionStyle]}
          >
            <GlassSurface
              preset="cinematic"
              elevation="raised"
              style={styles.previewSurface}
            >
              <View
                style={[
                  styles.previewClip,
                  previewPainted && styles.previewExpanded,
                ]}
              >
                {previewThumbnail && (
                  <Image
                    source={previewThumbnail}
                    contentFit="cover"
                    cachePolicy="none"
                    onDisplay={() => setPreviewPainted(true)}
                    style={styles.previewImage}
                  />
                )}
                <View style={styles.previewLabel}>
                  <Text style={styles.previewTime}>{formatTime(time)}</Text>
                </View>
              </View>
            </GlassSurface>
          </Animated.View>
        ) : null}
        <View style={styles.rail}>
          <Animated.View style={[styles.track, railEmphasis]}>
            <View style={[styles.buffered, { width: `${buffered * 100}%` }]} />
            <Animated.View style={[styles.progress, progressStyle]} />
          </Animated.View>
          <Animated.View
            style={[styles.thumb, thumbPositionStyle, thumbEmphasis]}
          />
        </View>
      </View>
    </GestureDetector>
  );
}

export function VideoTimecode({
  timeline,
  live,
  onChange,
}: {
  timeline: Timeline;
  live: boolean;
  onChange: () => void;
}) {
  const { t } = useTranslation("video");
  const [remaining, setRemaining] = useState(false);
  const { time, duration } = timeline;
  const end = remaining
    ? `−${formatTime(Math.max(0, duration - time))}`
    : formatTime(duration);
  if (live) return <Text style={styles.clock}>{t("viewer.live")}</Text>;
  if (duration <= 0 || !Number.isFinite(duration)) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(
        remaining ? "viewer.remainingTime" : "viewer.duration",
      )}
      accessibilityValue={{ text: `${formatTime(time)} / ${end}` }}
      onPress={() => {
        onChange();
        setRemaining((value) => !value);
      }}
      style={styles.timeButton}
    >
      <Text numberOfLines={1} style={styles.clock} maxFontSizeMultiplier={1.45}>
        {formatTime(time)} <Text style={styles.secondary}>/ {end}</Text>
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  railHit: {
    height: 38,
    justifyContent: "center",
    direction: "ltr",
    marginHorizontal: 7,
  },
  rail: { height: 3, justifyContent: "center" },
  track: {
    height: 3,
    backgroundColor: mediaMaterial.rail,
    borderRadius: theme.radius.round,
  },
  buffered: {
    position: "absolute",
    height: "100%",
    backgroundColor: mediaMaterial.buffered,
    borderRadius: theme.radius.round,
  },
  progress: {
    height: "100%",
    backgroundColor: mediaMaterial.accent,
    borderRadius: theme.radius.round,
  },
  thumb: {
    position: "absolute",
    width: 10,
    height: 10,
    marginLeft: -5,
    borderRadius: theme.radius.round,
    backgroundColor: mediaMaterial.ink,
  },
  preview: {
    position: "absolute",
    bottom: 34,
    left: 0,
    width: 124,
    marginLeft: -62,
    zIndex: 2,
  },
  previewSurface: { borderRadius: theme.radius.input, padding: 3 },
  previewClip: {
    overflow: "hidden",
    borderRadius: theme.radius.small,
    justifyContent: "flex-end",
    alignItems: "center",
  },
  previewExpanded: { aspectRatio: 1.6 },
  previewImage: {
    position: "absolute",
    width: "100%",
    aspectRatio: 1.6,
    top: 0,
  },
  previewLabel: {
    paddingVertical: 2,
    paddingHorizontal: theme.space.sm,
    margin: 3,
    borderRadius: theme.radius.round,
    backgroundColor: mediaMaterial.shade,
  },
  previewTime: {
    ...theme.type.meta,
    color: mediaMaterial.ink,
    fontVariant: ["tabular-nums"],
  },
  timeButton: { justifyContent: "center", minHeight: 44, flexShrink: 1 },
  clock: {
    ...theme.type.caption,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    color: mediaMaterial.ink,
    writingDirection: "ltr",
    textShadowColor: mediaMaterial.shade,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  secondary: { color: mediaMaterial.secondary, fontWeight: "400" },
}));
