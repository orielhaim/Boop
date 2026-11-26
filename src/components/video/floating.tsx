import { useEvent } from "expo";
import { Image, type ImageSource } from "expo-image";
import {
  isPictureInPictureSupported,
  VideoView,
  type VideoPlayer,
} from "expo-video";
import { useTranslation } from "react-i18next";
import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardState } from "react-native-keyboard-controller";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { useDialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import {
  dragFloatingAnchor,
  floatingVideoLayout,
  videoAspectRatio,
} from "@/core/video/floating-layout";
import { useTheme } from "@/theme";
import { StyleSheet } from "react-native-unistyles";
import { mediaMaterial } from "@/theme/tokens";
import { MediaControl } from "./media-controls";
import { useVideoControls } from "./interaction";
import type { CaptionBounds } from "./captions";

export type FloatingVideoProps = {
  player: VideoPlayer;
  title?: string;
  dimensions?: string | null;
  poster?: ImageSource | string;
  onClose: () => void;
  onExpand: () => void;
  background?: boolean;
  allowPiP?: boolean;
  onPictureInPictureChange?: (active: boolean) => void;
  captions?: (bounds?: CaptionBounds) => ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function FloatingVideo({
  player,
  title,
  dimensions,
  poster,
  onClose,
  onExpand,
  background = false,
  allowPiP = false,
  onPictureInPictureChange,
  captions,
  style,
}: FloatingVideoProps) {
  const { t } = useTranslation("video");
  const dialog = useDialog();
  const viewRef = useRef<VideoView>(null);
  const pipStarting = useRef(false);
  const { isPlaying } = useEvent(player, "playingChange", {
    isPlaying: player.playing,
  });
  const systemPiP = !background && allowPiP && isPictureInPictureSupported();
  const [pipActive, setPipActive] = useState(false);
  async function startSystemPiP() {
    const view = viewRef.current;
    if (!systemPiP || !view || pipStarting.current || pipActive) return;
    pipStarting.current = true;
    try {
      await view.startPictureInPicture();
    } catch {
      void dialog.show({
        title: t("viewer.pictureInPictureUnavailable"),
        tone: "error",
      });
    } finally {
      pipStarting.current = false;
    }
  }
  const { visible, toggle, reveal } = useVideoControls(
    !isPlaying || background,
  );
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
  const opening = !background && !firstFrameRendered && status !== "error";
  const fraction = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [viewport, setViewport] = useState<{ width: number; height: number }>();
  const [topControlsHeight, setTopControlsHeight] = useState(44);
  const [bottomControlsHeight, setBottomControlsHeight] = useState(44);
  const { reduceMotion } = useTheme();
  const keyboard = useKeyboardState((state) => state.isVisible);
  const { videoTrack } = useEvent(player, "videoTrackChange", {
    videoTrack: player.videoTrack,
  });
  const track =
    videoTrack ?? player.availableVideoTracks.find((item) => item.isSupported);
  const { width, height, left, top, travelX, travelY } = floatingVideoLayout({
    viewport: viewport ?? window,
    insets,
    aspectRatio: videoAspectRatio(track?.size, dimensions),
    keyboard,
    background,
  });
  const x = useSharedValue(1);
  const y = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  const drag = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!pipActive)
        .minDistance(6)
        .onStart(() => {
          startX.set(x.get());
          startY.set(y.get());
        })
        .onUpdate((event) => {
          x.set(dragFloatingAnchor(startX.get(), event.translationX, travelX));
          y.set(dragFloatingAnchor(startY.get(), event.translationY, travelY));
        }),
    [pipActive, startX, startY, travelX, travelY, x, y],
  );
  const position = useAnimatedStyle(() => ({
    transform: [
      { translateX: left + travelX * x.get() },
      { translateY: top + travelY * y.get() },
    ],
  }));

  return (
    <View
      pointerEvents="box-none"
      style={styles.overlay}
      onLayout={({ nativeEvent: { layout } }) => {
        const { width, height } = layout;
        if (width <= 0 || height <= 0) return;
        setViewport((previous) =>
          previous?.width === width && previous.height === height
            ? previous
            : { width, height },
        );
      }}
    >
      <GestureDetector gesture={drag}>
        <Animated.View
          style={[styles.positioner, { width, height }, position, style]}
        >
          <GlassSurface
            preset="cinematic"
            elevation="raised"
            style={styles.surface}
            accessibilityRole="none"
          >
            {!background && (
              <VideoView
                ref={viewRef}
                player={player}
                style={styles.video}
                contentFit="contain"
                nativeControls={false}
                surfaceType="textureView"
                allowsPictureInPicture={Boolean(systemPiP)}
                startsPictureInPictureAutomatically={Boolean(
                  systemPiP && isPlaying,
                )}
                onPictureInPictureStart={() => {
                  setPipActive(true);
                  onPictureInPictureChange?.(true);
                }}
                onPictureInPictureStop={() => {
                  setPipActive(false);
                  onPictureInPictureChange?.(false);
                }}
                onFirstFrameRender={() => setFirstFrameRendered(true)}
              />
            )}
            {poster && opening ? (
              <Image
                source={poster}
                contentFit="contain"
                cachePolicy="none"
                style={styles.poster}
              />
            ) : null}
            {opening && !pipActive && (
              <View pointerEvents="none" style={styles.loader}>
                <ActivityIndicator
                  color={mediaMaterial.ink}
                  accessibilityLabel={t("viewer.loading")}
                />
              </View>
            )}
            {!background &&
              !pipActive &&
              firstFrameRendered &&
              captions?.(
                visible
                  ? {
                      top: topControlsHeight + 8,
                      bottom: bottomControlsHeight + 8,
                      left: 4,
                      right: 4,
                    }
                  : undefined,
              )}
            {!pipActive &&
              (background ? (
                <View style={styles.audioRow}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("viewer.expand")}
                    onPress={onExpand}
                    style={styles.audioMain}
                  >
                    <View style={styles.audioIcon}>
                      <Icon
                        name="audio"
                        size={21}
                        color={mediaMaterial.accent}
                      />
                    </View>
                    <View style={styles.audioLabels}>
                      {title && (
                        <Text style={styles.title} numberOfLines={1}>
                          {title}
                        </Text>
                      )}
                      <Text style={styles.subtitle} numberOfLines={1}>
                        {t("viewer.listening")}
                      </Text>
                    </View>
                  </Pressable>
                  <MediaControl
                    label={t(isPlaying ? "viewer.pause" : "viewer.play")}
                    icon={isPlaying ? "pause" : "play"}
                    onPress={() => (isPlaying ? player.pause() : player.play())}
                  />
                  <MediaControl
                    label={t("viewer.close")}
                    icon="close"
                    onPress={onClose}
                  />
                </View>
              ) : (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t(
                      isPlaying
                        ? visible
                          ? "viewer.hideControls"
                          : "viewer.showControls"
                        : "viewer.expand",
                    )}
                    accessibilityActions={[
                      { name: "expand", label: t("viewer.expand") },
                    ]}
                    onAccessibilityAction={(event) => {
                      if (event.nativeEvent.actionName === "expand") onExpand();
                    }}
                    onPress={isPlaying ? toggle : onExpand}
                    style={styles.videoMain}
                  />
                  {visible && (
                    <Animated.View
                      entering={reduceMotion ? undefined : FadeIn.duration(160)}
                      exiting={reduceMotion ? undefined : FadeOut.duration(120)}
                      pointerEvents="box-none"
                      style={styles.videoControls}
                    >
                      <View
                        style={[styles.actions, styles.topActions]}
                        pointerEvents="box-none"
                        onLayout={({ nativeEvent }) =>
                          setTopControlsHeight(nativeEvent.layout.height)
                        }
                      >
                        <MediaControl
                          glass
                          label={t("viewer.expand")}
                          icon="fullscreen"
                          onPress={onExpand}
                        />
                        <MediaControl
                          glass
                          label={t("viewer.close")}
                          icon="close"
                          onPress={onClose}
                        />
                      </View>
                      <View
                        style={[styles.actions, styles.bottomActions]}
                        pointerEvents="box-none"
                        onLayout={({ nativeEvent }) =>
                          setBottomControlsHeight(nativeEvent.layout.height)
                        }
                      >
                        <MediaControl
                          glass
                          label={t(isPlaying ? "viewer.pause" : "viewer.play")}
                          icon={isPlaying ? "pause" : "play"}
                          onPress={() => {
                            reveal();
                            if (isPlaying) player.pause();
                            else player.play();
                          }}
                        />
                        {systemPiP && firstFrameRendered && (
                          <MediaControl
                            glass
                            label={t("viewer.systemPictureInPicture")}
                            icon="pictureInPicture"
                            onPress={() => void startSystemPiP()}
                          />
                        )}
                      </View>
                    </Animated.View>
                  )}
                </>
              ))}
            {!pipActive && (
              <View pointerEvents="none" style={styles.rim}>
                <View style={styles.track}>
                  <View
                    style={[styles.progress, { width: fraction * 100 + "%" }]}
                  />
                </View>
              </View>
            )}
          </GlassSurface>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 50, direction: "ltr" },
  positioner: { position: "absolute", top: 0, start: 0 },
  surface: {
    flex: 1,
    borderRadius: theme.radius.group,
    overflow: "hidden",
    backgroundColor: mediaMaterial.opaque,
  },
  video: StyleSheet.absoluteFillObject,
  poster: { ...StyleSheet.absoluteFillObject, zIndex: 1 },
  loader: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  videoMain: { ...StyleSheet.absoluteFillObject, zIndex: 3 },
  videoControls: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  actions: {
    position: "absolute",
    left: 4,
    right: 4,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  topActions: { top: 4 },
  bottomActions: { bottom: 4 },
  audioRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.space.sm,
  },
  audioMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.sm,
    minHeight: 44,
  },
  audioIcon: {
    width: 38,
    height: 38,
    backgroundColor: mediaMaterial.pressed,
    borderRadius: theme.radius.input,
    alignItems: "center",
    justifyContent: "center",
  },
  audioLabels: { flex: 1 },
  title: { ...theme.type.label, color: mediaMaterial.ink },
  subtitle: { ...theme.type.meta, color: mediaMaterial.secondary },
  rim: {
    ...StyleSheet.absoluteFillObject,
    borderColor: mediaMaterial.rim,
    borderWidth: 1,
    borderRadius: theme.radius.group,
    overflow: "hidden",
    zIndex: 5,
  },
  track: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: mediaMaterial.rail,
  },
  progress: { height: "100%", backgroundColor: mediaMaterial.accent },
}));
