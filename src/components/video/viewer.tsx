import { useEvent, useEventListener } from "expo";
import { Image, type ImageSource } from "expo-image";
import { BlurTargetView } from "expo-blur";
import {
  isPictureInPictureSupported,
  VideoView,
  type SubtitleTrack,
  type VideoContentFit,
  type VideoPlayer,
} from "expo-video";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import {
  AppState,
  Platform,
  StatusBar,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTranslation } from "react-i18next";
import { GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import type { TrayCoverage } from "@/components/glassyui/glass-tray";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { Icon } from "@/components/ui/icon";
import { useTheme } from "@/theme";
import { mediaMaterial } from "@/theme/tokens";
import { updateVideoPlayer } from "@/core/video/player-settings";
import { androidExternalSubtitleId } from "@/core/video/subtitles/tracks";
import type { CaptionBounds } from "./captions";
import {
  useVideoAppState,
  useVideoControls,
  useVideoGestureFeedback,
} from "./interaction";
import { VideoBlurTarget, VideoGestureFeedback } from "./media-controls";
import { useVideoOrientation } from "./orientation";
import { PlaybackTray, type SubtitleTrayScreen } from "./playback-tray";
import { useSurfaceGestures } from "./surface-gestures";
import { formatTime, useVideoTimeline } from "./timeline";
import { VideoChrome } from "./video-chrome";

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
  subtitleValue?: string;
  canManageSubtitles?: boolean;
  subtitleOptions?: (
    tracks: SubtitleTrack[],
    screen: SubtitleTrayScreen,
  ) => ReactNode;
  subtitleOverlay?: (
    controlsVisible: boolean,
    bounds: CaptionBounds,
  ) => ReactNode;
  onMemoryWarning?: (listener: () => void) => () => void;
  style?: StyleProp<ViewStyle>;
};

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
  subtitleValue,
  canManageSubtitles,
  subtitleOptions,
  subtitleOverlay,
  onMemoryWarning,
  style,
}: ViewerProps) {
  const { t } = useTranslation("video");
  const { reduceMotion, reduceTransparency } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const viewRef = useRef<VideoView>(null);
  const blurRef = useRef<ComponentRef<typeof View>>(null);
  const canSampleVideo = Platform.OS === "android" && advancedGestures;
  const Backdrop = canSampleVideo ? BlurTargetView : View;
  const orientation = useVideoOrientation();
  const foreground = useVideoAppState();
  const [fit, setFit] = useState<VideoContentFit>("contain");
  const [menu, setMenu] = useState<"subtitles" | "options" | null>(null);
  const [pip, setPip] = useState(false);
  const [loop, setLoop] = useState(player.loop);
  const [firstFrameRendered, setFirstFrameRendered] = useState(false);
  const [missingVideo, setMissingVideo] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(44);
  const [dockHeight, setDockHeight] = useState(82);
  const [trayCoverage, setTrayCoverage] = useState<TrayCoverage>();
  const reportTrayCoverage = useCallback((coverage: TrayCoverage) => {
    setTrayCoverage((previous) =>
      previous?.edge === coverage.edge && previous.size === coverage.size
        ? previous
        : coverage,
    );
  }, []);

  const { isPlaying } = useEvent(player, "playingChange", {
    isPlaying: player.playing,
  });
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
    { availableAudioTracks: player.availableAudioTracks },
  );
  const { availableSubtitleTracks } = useEvent(
    player,
    "availableSubtitleTracksChange",
    { availableSubtitleTracks: player.availableSubtitleTracks },
  );

  // A ready state can precede track discovery and the first displayed frame.
  const error =
    status === "error" ||
    (missingVideo &&
      status === "readyToPlay" &&
      !firstFrameRendered &&
      !player.availableVideoTracks.length);
  const opening = !background && !firstFrameRendered && !error;
  const buffering = !opening && !background && !error && status === "loading";
  const ready = !opening && !error;
  const pipSupported = !background && allowPiP && isPictureInPictureSupported();
  const interactions = useVideoGestureFeedback(
    player,
    advancedGestures && foreground && !pip && !background && !menu,
  );
  const { visible, screenReader, reveal, toggle } = useVideoControls(
    !isPlaying ||
      !ready ||
      buffering ||
      Boolean(menu || interactions.feedback) ||
      scrubbing,
  );
  const chromeVisible = visible && !pip;
  const chromeAccessible = chromeVisible && !menu && foreground;
  const timeline = useVideoTimeline({
    player,
    reduceMotion,
    isPlaying,
    reveal,
    onMemoryWarning,
    scrubbing,
    setScrubbing,
  });
  useEventListener(player, "playToEnd", () => {
    if (!loop) reveal();
  });
  const duration = timeline.duration;
  const seekable = Number.isFinite(duration) && duration > 0;
  const ended = !isPlaying && seekable && timeline.time >= duration - 0.25;
  const seek = timeline.seekBy;
  const { showSeek } = interactions;
  const seekWithFeedback = useCallback(
    (seconds: number, accumulate?: boolean) => {
      if (!seekable || seconds === 0 || AppState.currentState !== "active")
        return;
      seek(seconds);
      if (accumulate) showSeek(seconds);
    },
    [seek, seekable, showSeek],
  );
  const closeMenu = useCallback(() => setMenu(null), []);
  const togglePlayback = () => {
    reveal();
    if (isPlaying) player.pause();
    else if (ended) timeline.commitSeek(0);
    else player.play();
  };

  useEffect(() => {
    if (background || firstFrameRendered || status !== "readyToPlay") return;
    const watchdog = setTimeout(() => {
      if (
        player.status === "readyToPlay" &&
        !player.availableVideoTracks.length
      )
        setMissingVideo(true);
    }, 12_000);
    return () => clearTimeout(watchdog);
  }, [background, firstFrameRendered, player, status]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") setMenu(null);
    });
    return () => subscription.remove();
  }, []);

  const { gesture, surfaceStyle, videoStyle } = useSurfaceGestures({
    enabled:
      advancedGestures &&
      ready &&
      !background &&
      !screenReader &&
      !menu &&
      foreground,
    reduceMotion,
    width,
    height,
    toggleControls: toggle,
    close: onClose,
    minimize: onMinimize,
    seek: seekWithFeedback,
    adjustBrightness: interactions.adjustBrightness,
    adjustVolume: interactions.adjustVolume,
    temporaryRate: interactions.temporaryRate,
    restoreRate: interactions.restoreRate,
  });

  const togglePiP = async () => {
    const view = viewRef.current;
    if (!view || !pipSupported) return;
    try {
      await view.startPictureInPicture();
    } catch {
      setPip(false);
      onPictureInPictureChange?.(false);
    }
  };
  const embeddedSubtitleTracks = availableSubtitleTracks.filter(
    (track) => track.id !== androidExternalSubtitleId,
  );
  const subtitlesAvailable = Boolean(
    subtitleOptions &&
    (canManageSubtitles || embeddedSubtitleTracks.length > 0),
  );
  const mediaInsets = {
    left: Math.max(insets.left, 14),
    right: Math.max(insets.right, 14),
  };
  const top = insets.top + 10;
  const bottom = insets.bottom + 10;
  const captionBounds = {
    top: chromeVisible ? top + headerHeight + 8 : insets.top + 12,
    bottom:
      chromeVisible && ready ? bottom + dockHeight + 8 : insets.bottom + 16,
    ...mediaInsets,
  };
  const videoSize = player.videoTrack?.size;
  if (
    fit === "contain" &&
    videoSize &&
    videoSize.width > 0 &&
    videoSize.height > 0
  ) {
    const letterbox =
      (height - width * (videoSize.height / videoSize.width)) / 2;
    if (letterbox > 0) {
      captionBounds.top = Math.max(captionBounds.top, letterbox + 8);
      captionBounds.bottom = Math.max(captionBounds.bottom, letterbox + 8);
    }
  }
  if (menu && trayCoverage) {
    const { edge, size } = trayCoverage;
    const limit =
      edge === "bottom" ? height - captionBounds.top - 82 : width - 210;
    captionBounds[edge] = Math.max(captionBounds[edge], Math.min(limit, size));
  }

  return (
    <View style={[styles.root, style]}>
      <StatusBar hidden />
      <Animated.View style={[styles.stage, surfaceStyle]}>
        {!background && (
          <Animated.View
            style={[StyleSheet.absoluteFill, videoStyle]}
            pointerEvents="none"
          >
            <Backdrop ref={blurRef} style={StyleSheet.absoluteFill}>
              {/* Keep the letterboxing color inside the sampled subtree. */}
              {canSampleVideo && (
                <View collapsable={false} style={styles.backdrop} />
              )}
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
                  setPip(true);
                  closeMenu();
                  orientation.reset();
                  onPictureInPictureChange?.(true);
                }}
                onPictureInPictureStop={() => {
                  setPip(false);
                  onPictureInPictureChange?.(false);
                }}
                onFirstFrameRender={() => setFirstFrameRendered(true)}
              />
            </Backdrop>
          </Animated.View>
        )}
        {poster && opening && (
          <Image
            source={poster}
            cachePolicy="none"
            contentFit={fit}
            style={StyleSheet.absoluteFill}
          />
        )}
        <GestureDetector gesture={gesture}>
          <View
            collapsable={false}
            accessible={false}
            importantForAccessibility="no"
            style={StyleSheet.absoluteFill}
            pointerEvents={menu || pip ? "none" : "auto"}
          />
        </GestureDetector>
        {!background &&
          !pip &&
          firstFrameRendered &&
          subtitleOverlay?.(chromeVisible, captionBounds)}
        {background && (
          <View pointerEvents="none" style={styles.listening}>
            <GlassSurface preset="cinematic" style={styles.listeningIcon}>
              <Icon name="audio" size={24} color={mediaMaterial.accent} />
            </GlassSurface>
            <Text style={styles.listeningText}>{t("viewer.listening")}</Text>
          </View>
        )}

        <VideoBlurTarget.Provider
          value={
            canSampleVideo &&
            firstFrameRendered &&
            !background &&
            chromeVisible &&
            !menu &&
            !reduceTransparency
              ? blurRef
              : undefined
          }
        >
          {!pip && (
            <VideoChrome
              visible={chromeVisible}
              interactive={chromeAccessible}
              insets={{ ...mediaInsets, top, bottom }}
              onHeaderHeight={setHeaderHeight}
              onDockHeight={setDockHeight}
              title={title}
              state={
                error
                  ? "error"
                  : opening || buffering
                    ? "loading"
                    : isPlaying
                      ? "playing"
                      : ended
                        ? "ended"
                        : "paused"
              }
              showDock={ready}
              timeline={timeline}
              seekInterval={seekInterval}
              live={player.isLive}
              onClose={onClose}
              onExternal={onExternal}
              onMinimize={ready ? onMinimize : undefined}
              onPictureInPicture={
                ready && pipSupported ? () => void togglePiP() : undefined
              }
              onPlay={togglePlayback}
              onSeek={seekWithFeedback}
              onPrevious={onPrevious}
              onNext={onNext}
              subtitleActive={Boolean(subtitleValue || subtitleTrack)}
              onSubtitles={
                subtitlesAvailable && !background
                  ? () => setMenu("subtitles")
                  : undefined
              }
              muted={interactions.muted}
              onMute={() => {
                reveal();
                updateVideoPlayer(player, { muted: !player.muted });
              }}
              landscape={orientation.landscape}
              onOrientation={
                !background
                  ? () => {
                      reveal();
                      (orientation.landscape
                        ? orientation.reset
                        : orientation.enter)();
                    }
                  : undefined
              }
              onOptions={() => setMenu("options")}
              onTimeDisplay={reveal}
            />
          )}
          {!pip && !menu && interactions.feedback && (
            <VideoGestureFeedback feedback={interactions.feedback} />
          )}
        </VideoBlurTarget.Provider>
      </Animated.View>
      {foreground && !pip && (
        <PlaybackTray
          open={menu !== null}
          onCoverageChange={reportTrayCoverage}
          initialScreen={menu ?? "options"}
          onClose={closeMenu}
          player={player}
          audioTracks={availableAudioTracks}
          audioTrack={audioTrack}
          onSelectAudioTrack={(track) =>
            updateVideoPlayer(player, { audioTrack: track })
          }
          subtitleValue={
            subtitleValue ?? subtitleTrack?.label ?? t("viewer.subtitlesOff")
          }
          renderSubtitles={
            subtitlesAvailable && subtitleOptions
              ? (screen) => subtitleOptions(embeddedSubtitleTracks, screen)
              : undefined
          }
          playbackRate={interactions.playbackRate}
          fit={fit}
          onFitChange={setFit}
          loop={loop}
          onLoopChange={(value) => {
            setLoop(value);
            updateVideoPlayer(player, { loop: value });
          }}
          background={background}
          allowBackground={allowBackground}
          onBackgroundChange={
            onBackgroundChange
              ? (value) => {
                  setFirstFrameRendered(false);
                  setMissingVideo(false);
                  onBackgroundChange(value);
                }
              : undefined
          }
          onShare={onShare}
          onSave={onSave}
          onExternal={onExternal}
          onOrigin={onOrigin}
          videoInfo={{
            dimensions: player.videoTrack?.size
              ? `${player.videoTrack.size.width} × ${player.videoTrack.size.height}`
              : undefined,
            duration: seekable ? formatTime(duration) : undefined,
            audioTrack: audioTrack?.label,
            subtitleTrack: subtitleValue ?? subtitleTrack?.label,
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: mediaMaterial.canvas, overflow: "hidden" },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: mediaMaterial.canvas,
  },
  stage: { flex: 1, overflow: "hidden", backgroundColor: mediaMaterial.canvas },
  listening: {
    position: "absolute",
    top: "23%",
    alignSelf: "center",
    alignItems: "center",
    gap: theme.space.sm,
  },
  listeningIcon: { borderRadius: theme.radius.round, padding: theme.space.md },
  listeningText: { ...theme.type.label, color: mediaMaterial.secondary },
}));
