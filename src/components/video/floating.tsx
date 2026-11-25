import { useEvent } from "expo";
import { Image, type ImageSource } from "expo-image";
import {
  isPictureInPictureSupported,
  VideoView,
  type VideoPlayer,
} from "expo-video";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  cancelAnimation,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardState } from "react-native-keyboard-controller";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { Icon } from "@/components/ui/icon";
import { useTheme } from "@/theme";
import { StyleSheet } from "react-native-unistyles";
import { mediaMaterial, motion } from "@/theme/tokens";
import { ControlGroup, MediaControl } from "./media-controls";
import { useVideoControls } from "./interaction";

export type FloatingVideoProps = {
  player: VideoPlayer;
  title?: string;
  poster?: ImageSource | string;
  onClose: () => void;
  onExpand: () => void;
  background?: boolean;
  allowPiP?: boolean;
  onPictureInPictureChange?: (active: boolean) => void;
  captions?: (controlsVisible: boolean) => ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function FloatingVideo({
  player,
  title,
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
  const { isPlaying } = useEvent(player, "playingChange", {
    isPlaying: player.playing,
  });
  const systemPiP = !background && allowPiP && isPictureInPictureSupported();
  const [pipActive, setPipActive] = useState(false);
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
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { reduceMotion } = useTheme();
  const keyboard = useKeyboardState((state) => state.isVisible);
  const track = player.videoTrack?.size;
  const ratio =
    track && track.width > 0 && track.height > 0
      ? track.width / track.height
      : 16 / 9;
  const maxWidth = Math.min(260, Math.max(164, windowWidth * 0.62));
  const maxHeight = Math.min(windowHeight * 0.43, 238);
  const width = background
    ? Math.min(310, windowWidth - 24)
    : Math.max(146, Math.min(maxWidth, maxHeight * ratio));
  const height = background ? 72 : Math.min(maxHeight, width / ratio);
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

  const drag = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(14)
        .onStart(() => {
          cancelAnimation(x);
          cancelAnimation(y);
          startX.set(x.get());
          startY.set(y.get());
        })
        .onUpdate((event) => {
          x.set(
            Math.max(left, Math.min(right, startX.get() + event.translationX)),
          );
          y.set(
            Math.max(top, Math.min(bottom, startY.get() + event.translationY)),
          );
        })
        .onEnd(({ velocityX, velocityY }) => {
          rightDock.set(x.get() + velocityX * 0.12 >= (left + right) / 2);
          bottomDock.set(y.get() + velocityY * 0.12 >= (top + bottom) / 2);
          const nextX = rightDock.get() ? right : left;
          const nextY = bottomDock.get() ? bottom : top;
          x.set(reduceMotion ? nextX : withSpring(nextX, motion.travel));
          y.set(reduceMotion ? nextY : withSpring(nextY, motion.travel));
        }),
    [
      bottom,
      bottomDock,
      left,
      reduceMotion,
      right,
      rightDock,
      startX,
      startY,
      top,
      x,
      y,
    ],
  );
  const position = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }],
  }));

  return (
    <GestureDetector gesture={drag}>
      <Animated.View
        style={[
          styles.positioner,
          { top: 0, left: 0, width, height },
          position,
          style,
        ]}
      >
        <GlassSurface
          preset="cinematic"
          elevation="raised"
          style={styles.surface}
          accessibilityRole="none"
        >
          {!background && (
            <VideoView
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
            captions?.(visible)}
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
                    <Icon name="audio" size={21} color={mediaMaterial.accent} />
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
                    <View style={styles.actions} pointerEvents="box-none">
                      <MediaControl
                        glass
                        label={t("viewer.expand")}
                        icon="fullscreen"
                        onPress={onExpand}
                      />
                      <ControlGroup>
                        <MediaControl
                          label={t(isPlaying ? "viewer.pause" : "viewer.play")}
                          icon={isPlaying ? "pause" : "play"}
                          onPress={() => {
                            reveal();
                            if (isPlaying) player.pause();
                            else player.play();
                          }}
                        />
                        <MediaControl
                          label={t("viewer.close")}
                          icon="close"
                          onPress={onClose}
                        />
                      </ControlGroup>
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
  );
}

const styles = StyleSheet.create((theme) => ({
  positioner: { position: "absolute", zIndex: 50, direction: "ltr" },
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
    top: 4,
    left: 4,
    right: 4,
    flexDirection: "row",
    justifyContent: "space-between",
  },
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
