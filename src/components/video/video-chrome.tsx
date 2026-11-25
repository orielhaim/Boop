import { Text, useWindowDimensions, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, {
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { Icon } from "@/components/ui/icon";
import { directionFor, resolveLanguage } from "@/i18n";
import { useTheme } from "@/theme";
import { mediaMaterial } from "@/theme/tokens";
import type { CaptionBounds } from "./captions";
import {
  ControlGroup,
  MediaControl,
  VideoGlass,
  VideoTransport,
} from "./media-controls";
import {
  VideoTimecode,
  VideoTimeline,
  type useVideoTimeline,
} from "./timeline";

type ChromeProps = {
  visible: boolean;
  interactive: boolean;
  insets: CaptionBounds;
  onHeaderHeight: (height: number) => void;
  onDockHeight: (height: number) => void;
  title?: string;
  state: "error" | "loading" | "playing" | "paused" | "ended";
  showDock: boolean;
  timeline: ReturnType<typeof useVideoTimeline>;
  seekInterval: number;
  live: boolean;
  onClose: () => void;
  onExternal?: () => void;
  onMinimize?: () => void;
  onPictureInPicture?: () => void;
  onPlay: () => void;
  onSeek: (seconds: number) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  subtitleActive: boolean;
  onSubtitles?: () => void;
  muted: boolean;
  onMute: () => void;
  landscape: boolean;
  onOrientation?: () => void;
  onOptions: () => void;
  onTimeDisplay: () => void;
};

export function VideoChrome({
  visible,
  interactive,
  insets,
  onHeaderHeight,
  onDockHeight,
  title,
  state,
  showDock,
  timeline,
  seekInterval,
  live,
  onClose,
  onExternal,
  onMinimize,
  onPictureInPicture,
  onPlay,
  onSeek,
  onPrevious,
  onNext,
  subtitleActive,
  onSubtitles,
  muted,
  onMute,
  landscape,
  onOrientation,
  onOptions,
  onTimeDisplay,
}: ChromeProps) {
  const { t, i18n } = useTranslation("video");
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const { reduceMotion } = useTheme();
  const { width } = useWindowDimensions();
  const { left, right, top, bottom } = insets;
  const seekable = Number.isFinite(timeline.duration) && timeline.duration > 0;
  const lastFrame = useAnimatedStyle(() => ({
    opacity: reduceMotion
      ? Number(visible)
      : withTiming(Number(visible), {
          duration: visible ? 180 : 145,
        }),
  }));
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, lastFrame]}
      pointerEvents={interactive ? "box-none" : "none"}
      accessibilityElementsHidden={!interactive}
      importantForAccessibility={interactive ? "auto" : "no-hide-descendants"}
    >
      <View
        style={[styles.header, { left, right, top, direction }]}
        onLayout={(event) => onHeaderHeight(event.nativeEvent.layout.height)}
      >
        <MediaControl
          glass
          label={t("viewer.close")}
          icon="close"
          onPress={onClose}
        />
        {title ? (
          <VideoGlass elevation="none" style={styles.title}>
            <Text style={styles.titleText} numberOfLines={1}>
              {title}
            </Text>
          </VideoGlass>
        ) : null}
        <View style={styles.spacer} />
        {(onMinimize || onPictureInPicture) && (
          <ControlGroup>
            {onMinimize && (
              <MediaControl
                label={t("viewer.minimize")}
                icon="collapse"
                onPress={onMinimize}
              />
            )}
            {onPictureInPicture && (
              <MediaControl
                label={t("viewer.pictureInPicture")}
                icon="pictureInPicture"
                onPress={onPictureInPicture}
              />
            )}
          </ControlGroup>
        )}
      </View>
      {state === "error" ? (
        <View style={styles.middle} pointerEvents="box-none">
          <GlassSurface
            preset="cinematic"
            style={styles.error}
            accessibilityRole="alert"
          >
            <Icon name="warning" size={24} color={mediaMaterial.secondary} />
            <Text style={styles.errorText}>{t("viewer.loadFailed")}</Text>
            {onExternal && (
              <MediaControl
                glass
                label={t("viewer.external")}
                icon="openExternal"
                onPress={onExternal}
              />
            )}
          </GlassSurface>
        </View>
      ) : (
        <View style={styles.middle} pointerEvents="box-none">
          <VideoTransport
            status={state}
            seekable={seekable}
            interval={seekInterval}
            play={onPlay}
            seek={onSeek}
          />
        </View>
      )}
      {showDock && (
        <View
          style={[styles.dock, { left, right, bottom }]}
          onLayout={(event) => onDockHeight(event.nativeEvent.layout.height)}
        >
          <VideoTimeline timeline={timeline} seekInterval={seekInterval} />
          <View style={[styles.dockActions, { direction }]}>
            <VideoTimecode
              timeline={timeline}
              live={live}
              onChange={onTimeDisplay}
            />
            <View style={styles.spacer} />
            {(onPrevious || onNext) && width > 385 && (
              <ControlGroup>
                {onPrevious && (
                  <MediaControl
                    label={t("viewer.previous")}
                    icon="previous"
                    onPress={onPrevious}
                  />
                )}
                {onNext && (
                  <MediaControl
                    label={t("viewer.next")}
                    icon="next"
                    onPress={onNext}
                  />
                )}
              </ControlGroup>
            )}
            <ControlGroup>
              {onSubtitles && (
                <MediaControl
                  label={t("viewer.subtitles")}
                  icon="captions"
                  active={subtitleActive}
                  onPress={onSubtitles}
                />
              )}
              <MediaControl
                label={t(muted ? "viewer.unmute" : "viewer.mute")}
                icon={muted ? "speakerOff" : "speaker"}
                onPress={onMute}
              />
              {onOrientation && (
                <MediaControl
                  label={t(
                    landscape ? "viewer.resetOrientation" : "viewer.fullscreen",
                  )}
                  icon="fullscreen"
                  onPress={onOrientation}
                />
              )}
              <MediaControl
                label={t("viewer.options")}
                icon="settings"
                onPress={onOptions}
              />
            </ControlGroup>
          </View>
          {(onPrevious || onNext) && width <= 385 && (
            <ControlGroup style={styles.gallery}>
              {onPrevious && (
                <MediaControl
                  label={t("viewer.previous")}
                  icon="previous"
                  onPress={onPrevious}
                />
              )}
              {onNext && (
                <MediaControl
                  label={t("viewer.next")}
                  icon="next"
                  onPress={onNext}
                />
              )}
            </ControlGroup>
          )}
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.sm,
  },
  title: {
    flexShrink: 1,
    maxWidth: 338,
    borderRadius: theme.radius.round,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  titleText: {
    ...theme.type.label,
    color: mediaMaterial.ink,
    writingDirection: "auto",
    textShadowColor: mediaMaterial.shade,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  spacer: { flex: 1 },
  middle: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: theme.space.lg,
  },
  error: {
    padding: theme.space.xl,
    borderRadius: theme.radius.card,
    alignItems: "center",
    gap: theme.space.md,
  },
  errorText: {
    ...theme.type.body,
    color: mediaMaterial.ink,
    textAlign: "center",
  },
  dock: {
    position: "absolute",
    maxWidth: 1000,
    marginHorizontal: "auto",
    gap: theme.space.xs,
  },
  dockActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.xs,
  },
  gallery: { alignSelf: "flex-end" },
}));
