import { useEvent, useEventListener } from "expo";
import * as Brightness from "expo-brightness";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import type { ImageSource } from "expo-image";
import {
  isPictureInPictureSupported,
  VideoView,
  type AudioTrack,
  type SubtitleTrack,
  type VideoContentFit,
  type VideoPlayer,
  type VideoThumbnail,
} from "expo-video";
import { useTranslation } from "react-i18next";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  AccessibilityInfo,
  AppState,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withSpring,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardState } from "react-native-keyboard-controller";
import { Icon } from "@/components/ui/icon";
import { createScrubGesture } from "./scrub-gesture";
import { createScrubPreview } from "./scrub-preview";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "@/theme";
import { updateVideoPlayer } from "@/core/video/player-settings";
import { useVideoOrientation } from "./orientation";
import { useSurfaceGestures } from "./surface-gestures";

type ViewerProps = {
  player: VideoPlayer;
  onClose: () => void;
  onMinimize?: () => void;
  onShare?: () => void;
  onExternal?: () => void;
  onOrigin?: () => void;
  onPictureInPictureChange?: (active: boolean) => void;
  onBackgroundChange?: (enabled: boolean) => void;
  title?: string;
  poster?: ImageSource | string;
  automaticPiP?: boolean;
  allowPiP?: boolean;
  background?: boolean;
  allowBackground?: boolean;
  advancedGestures?: boolean;
  seekInterval?: number;
  onSave?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  subtitleExtra?: ReactNode | ((close: () => void) => ReactNode);
  subtitleOverlay?: (controlsVisible: boolean) => ReactNode;
  onSelectEmbeddedSubtitle?: () => void;
  onMemoryWarning?: (listener: () => void) => () => void;
  style?: StyleProp<ViewStyle>;
};

type FloatingVideoProps = Pick<
  ViewerProps,
  | "player"
  | "title"
  | "poster"
  | "onClose"
  | "background"
  | "allowPiP"
  | "onPictureInPictureChange"
> & {
  onExpand: () => void;
  style?: StyleProp<ViewStyle>;
};

type TrackChoice =
  | { kind: "audio"; track: AudioTrack }
  | { kind: "subtitle"; track: SubtitleTrack }
  | { kind: "subtitle-off" };

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  const clock = `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
};

function Control({
  label,
  onPress,
  children,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  compact?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        compact && styles.controlCompact,
        pressed && styles.pressed,
      ]}
      hitSlop={8}
    >
      {children}
    </Pressable>
  );
}

export function VideoViewer({
  player,
  onClose,
  onMinimize,
  onShare,
  onExternal,
  onOrigin,
  onPictureInPictureChange,
  onBackgroundChange,
  title,
  poster,
  automaticPiP = false,
  allowPiP = true,
  background = false,
  allowBackground = false,
  advancedGestures = false,
  seekInterval = 10,
  onSave,
  onPrevious,
  onNext,
  subtitleExtra,
  subtitleOverlay,
  onSelectEmbeddedSubtitle,
  onMemoryWarning,
  style,
}: ViewerProps) {
  const { t } = useTranslation("video");
  const { reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const viewRef = useRef<VideoView>(null);
  const [showControls, setControlsVisible] = useState(true);
  const [fit, setFit] = useState<VideoContentFit>("contain");
  const [trackMenu, setTrackMenu] = useState<
    "audio" | "subtitles" | "options" | "speed" | null
  >(null);
  const [previewThumbnail, setPreviewThumbnail] = useState<VideoThumbnail>();
  const [previewPainted, setPreviewPainted] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);
  const [committedTime, setCommittedTime] = useState<number>();
  const pendingSeek = useRef<number | undefined>(undefined);
  const [pipActive, setPipActive] = useState(false);
  const orientation = useVideoOrientation();
  const [screenReader, setScreenReader] = useState(false);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const brightness = useRef(0.5);
  const [loop, setLoop] = useState(player.loop);
  const [remainingTime, setRemainingTime] = useState(false);
  const [firstFrameRendered, setFirstFrameRendered] = useState(false);
  const scrubPlayback = useRef<{ wasPlaying: boolean } | null>(null);
  const originalBrightness = useRef<{ value: number; system: boolean } | null>(
    null,
  );
  const changedBrightness = useRef(false);
  const originalRate = useRef<number | undefined>(undefined);
  const [feedback, setFeedback] = useState<string>();
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const seekFeedback = useRef(0);
  const railWidthValue = useSharedValue(1);
  const progressValue = useSharedValue(0);
  const scrubProgress = useSharedValue(0);
  const scrubActive = useSharedValue(false);
  const lastPreviewProgress = useSharedValue(-1);
  const lastPreviewAt = useSharedValue(0);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const duration = player.duration;
  const { isPlaying } = useEvent(player, "playingChange", {
    isPlaying: player.playing,
  });
  const [currentTime, setCurrentTime] = useState(() => player.currentTime);
  const { status } = useEvent(player, "statusChange", {
    status: player.status,
    error: undefined,
  });
  const { audioTrack } = useEvent(player, "audioTrackChange", {
    audioTrack: player.audioTrack,
  });
  const { subtitleTrack } = useEvent(player, "subtitleTrackChange", {
    subtitleTrack: player.subtitleTrack,
  });
  const { availableAudioTracks } = useEvent(
    player,
    "availableAudioTracksChange",
    {
      availableAudioTracks: player.availableAudioTracks,
    },
  );
  const { availableSubtitleTracks } = useEvent(
    player,
    "availableSubtitleTracksChange",
    {
      availableSubtitleTracks: player.availableSubtitleTracks,
    },
  );

  const time = scrubbing ? scrubTime : (committedTime ?? currentTime);
  const endTime = player.isLive
    ? t("viewer.live")
    : remainingTime
      ? `−${formatTime(Math.max(0, duration - time))}`
      : formatTime(duration);
  const timecode = `${formatTime(time)} / ${endTime}`;
  const fraction = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;
  const buffered =
    duration > 0
      ? Math.max(0, Math.min(1, player.bufferedPosition / duration))
      : 0;
  const error =
    status === "error" ||
    (status === "readyToPlay" && player.availableVideoTracks.length === 0);
  const keepControls =
    !isPlaying || error || Boolean(trackMenu) || scrubbing || screenReader;
  const controlsVisible = showControls || keepControls;
  const loading =
    !error &&
    (status === "loading" ||
      status === "idle" ||
      (!firstFrameRendered && currentTime === 0));
  const pipSupported = !background && allowPiP && isPictureInPictureSupported();
  const { playbackRate } = useEvent(player, "playbackRateChange", {
    playbackRate: player.playbackRate,
  });

  useEffect(() => {
    const subscription = AccessibilityInfo.addEventListener(
      "screenReaderChanged",
      setScreenReader,
    );
    void AccessibilityInfo.isScreenReaderEnabled().then(setScreenReader);
    return () => subscription.remove();
  }, []);
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
      setForeground(state === "active");
      if (state === "active") return;
      previews.clear();
      if (!scrubPlayback.current) return;
      scrubPlayback.current = null;
      scrubActive.set(false);
      setPreviewThumbnail(undefined);
      setPreviewPainted(false);
      setScrubbing(false);
    });
    return () => subscription.remove();
  }, [previews, scrubActive]);

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

  useEffect(() => {
    if (!advancedGestures || !foreground || pipActive || background) return;
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
  }, [advancedGestures, background, foreground, pipActive]);

  const showFeedback = useCallback((label: string, active = false) => {
    clearTimeout(feedbackTimer.current);
    setFeedback(label);
    if (active) return;
    feedbackTimer.current = setTimeout(() => {
      setFeedback(undefined);
      seekFeedback.current = 0;
    }, 750);
  }, []);

  const restoreRate = useCallback(() => {
    if (originalRate.current !== undefined)
      updateVideoPlayer(player, { playbackRate: originalRate.current });
    originalRate.current = undefined;
  }, [player]);
  useEffect(
    () => () => {
      clearTimeout(feedbackTimer.current);
      restoreRate();
    },
    [restoreRate],
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
      setControlsVisible(true);
      setScrubbing(true);
      updateScrub(seconds);
    },
    [player, updateScrub],
  );

  const commitSeek = useCallback(
    (seconds: number, resume = true) => {
      if (AppState.currentState !== "active") return;
      pendingSeek.current = seconds;
      setCommittedTime(seconds);
      progressValue.set(seconds / duration);
      updateVideoPlayer(player, { currentTime: seconds });
      if (resume) player.play();
    },
    [duration, player, progressValue],
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
      if (seconds !== undefined) commitSeek(seconds);
      else if (playback.wasPlaying) player.play();
    },
    [commitSeek, player, previews],
  );

  const seekBy = useCallback(
    (delta: number, accumulate = false) => {
      if (duration <= 0 || !Number.isFinite(duration)) return;
      const base = pendingSeek.current ?? player.currentTime;
      commitSeek(Math.max(0, Math.min(duration, base + delta)), false);
      if (accumulate) {
        const previous = seekFeedback.current;
        seekFeedback.current =
          Math.sign(previous) === Math.sign(delta) ? previous + delta : delta;
        showFeedback(
          (delta > 0 ? "+" : "−") + Math.abs(seekFeedback.current) + " s",
        );
      }
    },
    [commitSeek, duration, player, showFeedback],
  );

  const progressStyle = useAnimatedStyle(() => ({
    width: `${(scrubActive.get() ? scrubProgress.get() : progressValue.get()) * 100}%`,
  }));
  const thumbPositionStyle = useAnimatedStyle(() => ({
    left: `${(scrubActive.get() ? scrubProgress.get() : progressValue.get()) * 100}%`,
  }));
  const previewPositionStyle = useAnimatedStyle(() => {
    const width = railWidthValue.get();
    const halfPreview = Math.min(46, width / 2);
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

  const adjustBrightness = useCallback(
    (delta: number, active: boolean) => {
      if (!originalBrightness.current) return;
      const next = Math.max(0, Math.min(1, brightness.current + delta));
      if (next !== brightness.current) {
        brightness.current = next;
        changedBrightness.current = true;
        void Brightness.setBrightnessAsync(next).catch(() => undefined);
      }
      showFeedback(
        t("viewer.brightness") + " " + Math.round(next * 100) + "%",
        active,
      );
    },
    [showFeedback, t],
  );
  const adjustVolume = useCallback(
    (delta: number, active: boolean) => {
      if (AppState.currentState !== "active") return;
      const current = player.volume;
      const next = Math.max(0, Math.min(1, current + delta));
      if (player.muted) updateVideoPlayer(player, { muted: false });
      if (next !== current) updateVideoPlayer(player, { volume: next });
      showFeedback(
        t("viewer.volume") + " " + Math.round(next * 100) + "%",
        active,
      );
    },
    [player, showFeedback, t],
  );
  const toggleControls = useCallback(
    () => setControlsVisible((visible) => !visible),
    [],
  );
  const temporaryRate = useCallback(
    (rate: number) => {
      originalRate.current ??= player.playbackRate;
      updateVideoPlayer(player, { playbackRate: rate });
      showFeedback(rate + "×");
    },
    [player, showFeedback],
  );
  const {
    gesture: surfaceGesture,
    surfaceStyle,
    videoStyle,
  } = useSurfaceGestures({
    enabled: advancedGestures && !background && !screenReader,
    reduceMotion,
    width: windowWidth,
    height: windowHeight,
    toggleControls,
    close: onClose,
    minimize: onMinimize,
    seek: seekBy,
    adjustBrightness,
    adjustVolume,
    temporaryRate,
    restoreRate,
  });

  const togglePiP = useCallback(async () => {
    if (!viewRef.current || !pipSupported) return;
    try {
      if (pipActive) await viewRef.current.stopPictureInPicture();
      else await viewRef.current.startPictureInPicture();
    } catch {
      setPipActive(false);
      onPictureInPictureChange?.(false);
    }
  }, [onPictureInPictureChange, pipActive, pipSupported]);

  const chooseTrack = useCallback(
    (choice: TrackChoice) => {
      if (choice.kind === "audio")
        updateVideoPlayer(player, { audioTrack: choice.track });
      else {
        onSelectEmbeddedSubtitle?.();
        updateVideoPlayer(player, {
          subtitleTrack: choice.kind === "subtitle" ? choice.track : null,
        });
      }
      setTrackMenu(null);
    },
    [onSelectEmbeddedSubtitle, player],
  );

  const trackOptions =
    trackMenu === "audio"
      ? availableAudioTracks.map((track, index) => ({
          key: track.id ?? `${track.language}-${index}`,
          title: track.label || track.name || track.language,
          selected: audioTrack === track,
          choice: { kind: "audio", track } satisfies TrackChoice,
        }))
      : [
          {
            key: "off",
            title: t("viewer.subtitlesOff"),
            selected: subtitleTrack === null,
            choice: { kind: "subtitle-off" } satisfies TrackChoice,
          },
          ...availableSubtitleTracks.map((track, index) => ({
            key: track.id ?? `${track.language}-${index}`,
            title: track.label || track.name || track.language,
            selected: subtitleTrack === track,
            choice: { kind: "subtitle", track } satisfies TrackChoice,
          })),
        ];

  useEffect(() => {
    if (keepControls || pipActive || !showControls) return;
    const timeout = setTimeout(() => setControlsVisible(false), 3500);
    return () => clearTimeout(timeout);
  }, [keepControls, pipActive, showControls]);

  return (
    <View style={[styles.root, style]}>
      <StatusBar hidden />
      <GestureDetector gesture={surfaceGesture}>
        <Animated.View style={[styles.surface, surfaceStyle]}>
          {!background && (
            <Animated.View
              style={[StyleSheet.absoluteFill, videoStyle]}
              pointerEvents="none"
            >
              <VideoView
                ref={viewRef}
                style={StyleSheet.absoluteFill}
                player={player}
                nativeControls={false}
                contentFit={fit}
                surfaceType={advancedGestures ? "textureView" : "surfaceView"}
                allowsPictureInPicture={pipSupported}
                startsPictureInPictureAutomatically={
                  automaticPiP && pipSupported && isPlaying
                }
                onPictureInPictureStart={() => {
                  setPipActive(true);
                  orientation.reset();
                  onPictureInPictureChange?.(true);
                }}
                onPictureInPictureStop={() => {
                  setPipActive(false);
                  onPictureInPictureChange?.(false);
                }}
                onFirstFrameRender={() => setFirstFrameRendered(true)}
              />
            </Animated.View>
          )}
          {background && (
            <View style={styles.listening}>
              <Icon name="audio" size={42} color="#fff" />
              <Text style={styles.listeningText}>{t("viewer.listening")}</Text>
            </View>
          )}
          {!background && !pipActive && subtitleOverlay?.(controlsVisible)}
          {poster && !background && (loading || error) ? (
            <Image
              source={poster}
              cachePolicy="none"
              contentFit={fit}
              style={styles.poster}
            />
          ) : null}
          {error ? (
            <View style={styles.errorNotice} accessibilityRole="alert">
              <Text style={styles.errorText}>{t("viewer.loadFailed")}</Text>
              {onExternal ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={onExternal}
                  style={styles.errorAction}
                >
                  <Text style={styles.errorActionText}>
                    {t("viewer.external")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {loading && !background ? (
            <ActivityIndicator
              color="#fff"
              accessibilityLabel={t("viewer.loading")}
              style={styles.loader}
            />
          ) : null}
          {screenReader && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                controlsVisible
                  ? t("viewer.hideControls")
                  : t("viewer.showControls")
              }
              onPress={toggleControls}
              style={styles.tapSurface}
            />
          )}
          {controlsVisible ? (
            <Animated.View
              entering={reduceMotion ? undefined : FadeIn.duration(140)}
              exiting={reduceMotion ? undefined : FadeOut.duration(100)}
              style={[
                styles.overlay,
                {
                  paddingTop: insets.top + 10,
                  paddingBottom: insets.bottom + 14,
                },
              ]}
              pointerEvents="box-none"
            >
              <LinearGradient
                pointerEvents="none"
                colors={["#000b", "#0000"]}
                style={styles.topGradient}
              />
              <LinearGradient
                pointerEvents="none"
                colors={["#0000", "#000d"]}
                style={styles.bottomGradient}
              />
              <View style={styles.topBar}>
                <Control label={t("viewer.close")} onPress={onClose}>
                  <Icon name="close" color="#fff" size={23} weight="bold" />
                </Control>
                {title ? (
                  <Text style={styles.title} numberOfLines={1}>
                    {title}
                  </Text>
                ) : (
                  <View style={styles.titleSpacer} />
                )}
                {onMinimize ? (
                  <Control label={t("viewer.minimize")} onPress={onMinimize}>
                    <Icon name="expand" color="#fff" size={23} weight="bold" />
                  </Control>
                ) : null}
                <Control
                  label={t("viewer.options")}
                  onPress={() => setTrackMenu("options")}
                >
                  <Icon name="more" size={24} weight="bold" color="#fff" />
                </Control>
              </View>

              <View
                style={styles.centerControls}
                pointerEvents="box-none"
                accessibilityElementsHidden={error}
              >
                {!error && (
                  <>
                    <Control
                      label={t("viewer.seekBack", { seconds: seekInterval })}
                      compact
                      onPress={() => seekBy(-seekInterval)}
                    >
                      <Text style={styles.seekGlyph}>−{seekInterval}</Text>
                    </Control>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        isPlaying ? t("viewer.pause") : t("viewer.play")
                      }
                      onPress={() => {
                        if (isPlaying) player.pause();
                        else if (
                          duration > 0 &&
                          player.currentTime >= duration - 0.25
                        )
                          commitSeek(0);
                        else player.play();
                      }}
                      style={styles.mainPlay}
                    >
                      {isPlaying ? (
                        <Icon
                          name="pause"
                          color="#101010"
                          size={30}
                          weight="fill"
                        />
                      ) : (
                        <Icon
                          name="play"
                          color="#101010"
                          size={30}
                          weight="fill"
                        />
                      )}
                    </Pressable>
                    <Control
                      label={t("viewer.seekForward", { seconds: seekInterval })}
                      compact
                      onPress={() => seekBy(seekInterval)}
                    >
                      <Text style={styles.seekGlyph}>+{seekInterval}</Text>
                    </Control>
                  </>
                )}
              </View>

              <View style={styles.bottomPanel}>
                <View style={styles.timelineRow}>
                  <GestureDetector gesture={scrubGesture}>
                    <View
                      onLayout={onRailLayout}
                      accessibilityRole="adjustable"
                      accessibilityLabel={t("viewer.timeline")}
                      accessibilityValue={{ min: 0, max: duration, now: time }}
                      accessibilityActions={[
                        {
                          name: "increment",
                          label: t("viewer.seekForward", {
                            seconds: seekInterval,
                          }),
                        },
                        {
                          name: "decrement",
                          label: t("viewer.seekBack", {
                            seconds: seekInterval,
                          }),
                        },
                      ]}
                      onAccessibilityAction={(event) =>
                        seekBy(
                          event.nativeEvent.actionName === "increment"
                            ? seekInterval
                            : -seekInterval,
                        )
                      }
                      style={styles.railHit}
                    >
                      {scrubbing && previewVisible ? (
                        <Animated.View
                          pointerEvents="none"
                          style={[
                            styles.previewFrame,
                            (!previewThumbnail || !previewPainted) &&
                              styles.previewTimeOnly,
                            previewPositionStyle,
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
                          <Text style={styles.previewTime}>
                            {formatTime(time)}
                          </Text>
                        </Animated.View>
                      ) : null}
                      <View style={styles.rail}>
                        <View
                          style={[
                            styles.buffered,
                            { width: `${buffered * 100}%` },
                          ]}
                        />
                        <Animated.View
                          style={[styles.progress, progressStyle]}
                        />
                        <Animated.View
                          style={[styles.thumb, thumbPositionStyle]}
                        />
                      </View>
                    </View>
                  </GestureDetector>
                  {player.isLive ? (
                    <Text style={[styles.timeLabel, styles.timeWidth]}>
                      {timecode}
                    </Text>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t(
                        remainingTime
                          ? "viewer.remainingTime"
                          : "viewer.duration",
                      )}
                      accessibilityValue={{ text: timecode }}
                      onPress={() => setRemainingTime((value) => !value)}
                      style={[styles.timeButton, styles.timeWidth]}
                    >
                      <Text style={styles.timeLabel}>{timecode}</Text>
                    </Pressable>
                  )}
                </View>
                <View style={styles.transportRow}>
                  <Control
                    label={player.muted ? t("viewer.unmute") : t("viewer.mute")}
                    onPress={() => {
                      updateVideoPlayer(player, { muted: !player.muted });
                    }}
                    compact
                  >
                    {player.muted ? (
                      <Icon name="speakerOff" size={21} color="#fff" />
                    ) : (
                      <Icon name="speaker" size={21} color="#fff" />
                    )}
                  </Control>
                  {availableSubtitleTracks.length > 0 || subtitleExtra ? (
                    <Control
                      label={t("viewer.subtitles")}
                      onPress={() => setTrackMenu("subtitles")}
                      compact
                    >
                      <Icon name="captions" size={21} color="#fff" />
                    </Control>
                  ) : null}
                  {pipSupported ? (
                    <Control
                      label={t("viewer.pictureInPicture")}
                      onPress={() => void togglePiP()}
                      compact
                    >
                      <Icon name="pictureInPicture" size={20} color="#fff" />
                    </Control>
                  ) : null}
                  {onPrevious ? (
                    <Control
                      label={t("viewer.previous")}
                      onPress={onPrevious}
                      compact
                    >
                      <Text style={styles.saveGlyph}>‹</Text>
                    </Control>
                  ) : null}
                  {onNext ? (
                    <Control label={t("viewer.next")} onPress={onNext} compact>
                      <Text style={styles.saveGlyph}>›</Text>
                    </Control>
                  ) : null}
                  {!background && (
                    <Control
                      label={t(
                        orientation.landscape
                          ? "viewer.resetOrientation"
                          : "viewer.fullscreen",
                      )}
                      onPress={
                        orientation.landscape
                          ? orientation.reset
                          : orientation.enter
                      }
                      compact
                    >
                      <Icon name="fullscreen" size={20} color="#fff" />
                    </Control>
                  )}
                </View>
              </View>
            </Animated.View>
          ) : null}
        </Animated.View>
      </GestureDetector>

      {feedback && (
        <View
          pointerEvents="none"
          style={[styles.feedback, { top: insets.top + 68 }]}
        >
          <Text style={styles.feedbackText}>{feedback}</Text>
        </View>
      )}

      <Modal
        visible={trackMenu !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setTrackMenu(null)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setTrackMenu(null)}
        >
          <View style={styles.trackSheet}>
            <Text style={styles.trackTitle}>
              {t(
                trackMenu === "audio"
                  ? "viewer.audio"
                  : trackMenu === "subtitles"
                    ? "viewer.subtitles"
                    : trackMenu === "speed"
                      ? "viewer.speed"
                      : "viewer.options",
              )}
            </Text>
            <ScrollView>
              {trackMenu === "options" ? (
                <>
                  <MenuRow
                    label={t("viewer.speed")}
                    detail={playbackRate + "×"}
                    action={() => setTrackMenu("speed")}
                  />
                  <MenuRow
                    label={t(fit === "contain" ? "viewer.fill" : "viewer.fit")}
                    action={() => {
                      setFit(fit === "contain" ? "cover" : "contain");
                      setTrackMenu(null);
                    }}
                  />
                  <MenuRow
                    label={t("viewer.repeat")}
                    selected={loop}
                    action={() => {
                      updateVideoPlayer(player, { loop: !loop });
                      setLoop(!loop);
                    }}
                  />
                  {availableAudioTracks.length > 1 && (
                    <MenuRow
                      label={t("viewer.audio")}
                      action={() => setTrackMenu("audio")}
                    />
                  )}
                  {allowBackground && onBackgroundChange && (
                    <MenuRow
                      label={t(
                        background
                          ? "viewer.watchVideo"
                          : "viewer.backgroundPlayback",
                      )}
                      selected={background}
                      action={() => {
                        setFirstFrameRendered(false);
                        onBackgroundChange(!background);
                        setTrackMenu(null);
                      }}
                    />
                  )}
                  {onShare && (
                    <MenuRow
                      label={t("viewer.share")}
                      action={() => {
                        setTrackMenu(null);
                        onShare();
                      }}
                    />
                  )}
                  {onSave && (
                    <MenuRow
                      label={t("viewer.save")}
                      action={() => {
                        setTrackMenu(null);
                        onSave();
                      }}
                    />
                  )}
                  {onExternal && (
                    <MenuRow
                      label={t("viewer.external")}
                      action={() => {
                        setTrackMenu(null);
                        onExternal();
                      }}
                    />
                  )}
                  {onOrigin && (
                    <MenuRow
                      label={t("viewer.origin")}
                      action={() => {
                        setTrackMenu(null);
                        onOrigin();
                      }}
                    />
                  )}
                  {duration > 0 && (
                    <Text style={styles.fileDetails}>
                      {[
                        player.videoTrack?.size
                          ? `${player.videoTrack.size.width} × ${player.videoTrack.size.height}`
                          : undefined,
                        formatTime(duration),
                        audioTrack?.label,
                        subtitleTrack?.label,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  )}
                </>
              ) : trackMenu === "speed" ? (
                [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((rate) => (
                  <MenuRow
                    key={rate}
                    label={rate + "×"}
                    selected={rate === playbackRate}
                    action={() => {
                      updateVideoPlayer(player, { playbackRate: rate });
                      setTrackMenu(null);
                    }}
                  />
                ))
              ) : (
                trackOptions.map((item) => (
                  <MenuRow
                    key={item.key}
                    label={item.title}
                    selected={item.selected}
                    action={() => chooseTrack(item.choice)}
                  />
                ))
              )}
            </ScrollView>
            {trackMenu === "subtitles"
              ? typeof subtitleExtra === "function"
                ? subtitleExtra(() => setTrackMenu(null))
                : subtitleExtra
              : null}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

export function MenuRow({
  label,
  detail,
  selected,
  action,
}: {
  label: string;
  detail?: string;
  selected?: boolean;
  action(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={action}
      style={styles.trackRow}
    >
      <Text style={styles.trackLabel}>{label}</Text>
      {detail && <Text style={styles.timeLabel}>{detail}</Text>}
      {selected && <View style={styles.selectedDot} />}
    </Pressable>
  );
}

export function FloatingVideo({
  player,
  title,
  poster,
  onClose,
  onExpand,
  background,
  allowPiP,
  onPictureInPictureChange,
  style,
}: FloatingVideoProps) {
  const { t } = useTranslation("video");
  const { isPlaying } = useEvent(player, "playingChange", {
    isPlaying: player.playing,
  });
  const systemPiP = !background && allowPiP && isPictureInPictureSupported();
  const { status } = useEvent(player, "statusChange", {
    status: player.status,
    error: undefined,
  });
  const [firstFrameRendered, setFirstFrameRendered] = useState(false);
  const { currentTime } = useEvent(player, "timeUpdate", {
    currentTime: player.currentTime,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: player.bufferedPosition,
  });
  const duration = player.duration;
  const loading =
    status === "loading" ||
    status === "idle" ||
    (!firstFrameRendered && currentTime === 0);
  const fraction = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const insets = useSafeAreaInsets();

  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const keyboard = useKeyboardState((state) => state.isVisible);
  const { reduceMotion } = useTheme();
  const track = player.videoTrack?.size;
  const width = Math.min(196, Math.max(120, windowWidth * 0.44));
  const ratio = track?.height ? track.width / track.height : 16 / 9;
  const height = background ? 74 : Math.max(86, Math.min(180, width / ratio));
  const left = insets.left + 12;
  const right = Math.max(left, windowWidth - insets.right - width - 12);
  const top = insets.top + 14;
  const bottom = keyboard
    ? top
    : Math.max(top, windowHeight - insets.bottom - height - 88);
  const rightDock = useSharedValue(true);
  const bottomDock = useSharedValue(true);
  const x = useSharedValue(right);
  const y = useSharedValue(bottom);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  useEffect(() => {
    x.set(rightDock.get() ? right : left);
    y.set(bottomDock.get() ? bottom : top);
  }, [bottom, bottomDock, left, right, rightDock, top, x, y]);

  const drag = Gesture.Pan()
    .minDistance(14)
    .onStart(() => {
      startX.set(x.get());
      startY.set(y.get());
    })
    .onUpdate((event) => {
      x.set(Math.max(left, Math.min(right, startX.get() + event.translationX)));
      y.set(Math.max(top, Math.min(bottom, startY.get() + event.translationY)));
    })
    .onFinalize(() => {
      rightDock.set(x.get() >= (left + right) / 2);
      bottomDock.set(y.get() >= (top + bottom) / 2);
      const nextX = rightDock.get() ? right : left;
      const nextY = bottomDock.get() ? bottom : top;
      x.set(reduceMotion ? nextX : withSpring(nextX, { damping: 22 }));
      y.set(reduceMotion ? nextY : withSpring(nextY, { damping: 22 }));
    });
  const position = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }],
  }));

  return (
    <GestureDetector gesture={drag}>
      <Animated.View
        style={[
          styles.floating,
          { top: 0, left: 0, width, height },
          position,
          style,
        ]}
      >
        {!background && (
          <VideoView
            player={player}
            style={styles.floatingVideo}
            contentFit="contain"
            nativeControls={false}
            surfaceType="textureView"
            allowsPictureInPicture={Boolean(systemPiP)}
            startsPictureInPictureAutomatically={Boolean(systemPiP)}
            onPictureInPictureStart={() => onPictureInPictureChange?.(true)}
            onPictureInPictureStop={() => onPictureInPictureChange?.(false)}
            onFirstFrameRender={() => setFirstFrameRendered(true)}
          />
        )}
        {poster && loading && !background ? (
          <Image
            source={poster}
            contentFit="contain"
            cachePolicy="none"
            style={styles.floatingPoster}
          />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("viewer.expand")}
          onPress={onExpand}
          style={styles.floatingMain}
        >
          <Text style={styles.floatingTitle} numberOfLines={1}>
            {background ? t("viewer.listening") : (title ?? t("viewer.title"))}
          </Text>
        </Pressable>
        <View style={styles.floatingControls}>
          <Control
            label={isPlaying ? t("viewer.pause") : t("viewer.play")}
            onPress={() => (isPlaying ? player.pause() : player.play())}
            compact
          >
            {isPlaying ? (
              <Icon name="pause" size={19} color="#fff" weight="fill" />
            ) : (
              <Icon name="play" size={19} color="#fff" weight="fill" />
            )}
          </Control>
          <Control label={t("viewer.close")} onPress={onClose} compact>
            <Icon name="close" color="#fff" size={18} />
          </Control>
        </View>
        <View style={styles.floatingTrack}>
          <View
            style={[styles.floatingProgress, { width: `${fraction * 100}%` }]}
          />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#050505", overflow: "hidden" },
  surface: { flex: 1, backgroundColor: "#050505", overflow: "hidden" },
  poster: { ...StyleSheet.absoluteFill, zIndex: 1 },
  loader: { position: "absolute", top: "50%", alignSelf: "center", zIndex: 2 },
  errorNotice: {
    position: "absolute",
    top: "42%",
    left: 28,
    right: 28,
    zIndex: 6,
    alignItems: "center",
    gap: 12,
  },
  errorText: { color: "#fff", fontSize: 15, textAlign: "center" },
  errorAction: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  errorActionText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  tapSurface: {
    ...StyleSheet.absoluteFill,
    zIndex: 3,
    backgroundColor: "transparent",
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 4,
    justifyContent: "space-between",
    paddingHorizontal: 18,
  },
  topGradient: { position: "absolute", top: 0, left: 0, right: 0, height: 140 },
  bottomGradient: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 190,
  },
  listening: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingBottom: 260,
  },
  listeningText: { color: "#fff", fontSize: 17, fontWeight: "600" },
  fileDetails: { color: "#bbb", fontSize: 13, paddingVertical: 16 },
  topBar: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8 },
  title: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
    textAlign: "left",
  },
  titleSpacer: { flex: 1 },
  control: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: "rgba(18,18,18,0.52)",
  },
  controlCompact: { width: 38, height: 38, backgroundColor: "transparent" },
  pressed: { opacity: 0.6 },
  centerControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 32,
  },
  mainPlay: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(255,255,255,0.92)",
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: 3,
  },
  seekGlyph: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  saveGlyph: { color: "#fff", fontSize: 19, fontWeight: "600" },
  bottomPanel: { gap: 5 },
  previewFrame: {
    position: "absolute",
    left: 0,
    bottom: 25,
    width: 92,
    height: 68,
    marginLeft: -46,
    borderRadius: 9,
    overflow: "hidden",
    backgroundColor: "#111",
    borderColor: "rgba(255,255,255,0.8)",
    borderWidth: 1,
    justifyContent: "flex-end",
  },
  previewTimeOnly: { height: 18 },
  previewImage: { position: "absolute", top: 0, width: 92, height: 52 },
  previewTime: {
    color: "#fff",
    backgroundColor: "rgba(0,0,0,0.75)",
    fontSize: 10,
    textAlign: "center",
    height: 16,
    fontVariant: ["tabular-nums"],
  },
  timelineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  timeWidth: { maxWidth: "55%" },
  timeButton: { minHeight: 44, justifyContent: "center" },
  timeLabel: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "500",
    fontVariant: ["tabular-nums"],
    writingDirection: "ltr",
  },
  railHit: { flex: 1, height: 44, justifyContent: "center", direction: "ltr" },
  rail: {
    height: 4,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.30)",
    overflow: "visible",
    justifyContent: "center",
  },
  buffered: {
    position: "absolute",
    height: 4,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.5)",
  },
  progress: {
    position: "absolute",
    height: 4,
    borderRadius: 3,
    backgroundColor: "#fff",
  },
  thumb: {
    position: "absolute",
    width: 12,
    height: 12,
    borderRadius: 6,
    marginLeft: -6,
    backgroundColor: "#fff",
  },
  transportRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 2,
  },
  feedback: {
    position: "absolute",
    alignSelf: "center",
    backgroundColor: "#000b",
    borderRadius: 15,
    paddingVertical: 8,
    paddingHorizontal: 16,
    zIndex: 9,
  },
  feedbackText: {
    color: "#fff",
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  trackSheet: {
    maxHeight: "70%",
    padding: 22,
    paddingBottom: 34,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: "#171717",
  },
  trackTitle: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 12,
  },
  trackRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.15)",
  },
  trackLabel: { color: "#fff", fontSize: 15, flex: 1 },
  selectedDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: "#fff",
  },
  emptyTracks: { paddingVertical: 20, color: "rgba(255,255,255,0.7)" },
  floating: {
    position: "absolute",
    width: 300,
    height: 82,
    borderRadius: 18,
    overflow: "hidden",
    backgroundColor: "#181818",
    elevation: 12,
    zIndex: 50,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
  },
  floatingVideo: { ...StyleSheet.absoluteFill },
  floatingPoster: { ...StyleSheet.absoluteFill, zIndex: 1 },
  floatingMain: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    justifyContent: "center",
    paddingHorizontal: 14,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  floatingTitle: {
    maxWidth: 190,
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },
  floatingControls: {
    position: "absolute",
    right: 5,
    top: 6,
    bottom: 6,
    flexDirection: "row",
    alignItems: "center",
    zIndex: 3,
    backgroundColor: "rgba(0,0,0,0.38)",
    borderRadius: 20,
  },
  floatingTrack: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: "rgba(255,255,255,0.35)",
    zIndex: 4,
  },
  floatingProgress: { height: 3, backgroundColor: "#fff" },
});
