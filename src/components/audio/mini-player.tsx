import { router, useGlobalSearchParams, usePathname } from "expo-router";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Pressable, useWindowDimensions, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  cancelAnimation,
  Easing,
  FadeInUp,
  FadeOutUp,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  SafeAreaInsetsContext,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { useStore } from "zustand";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { navigationScene } from "@/components/navigation/scene";
import { IconButton, Ink } from "@/components/ui/kit";
import { playerPlayback } from "@/core/audio/controller";
import { showMiniPlayer, voiceOrigin } from "@/core/audio/types";
import { useLocal } from "@/services/local-context";
import { space, type as typography, useTheme } from "@/theme";
import { AudioTimestamp, SeekControl, SpeedControl } from "./controls";
import { PlayerPresentation, usePlayerPresentation } from "./presentation";

const playerPaddingTop = 5;
const playerPaddingBottom = 2;

export function AudioFrame({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { view } = useGlobalSearchParams<{ view?: string }>();
  const { audio } = useLocal();
  const { reduceMotion, colors } = useTheme();
  const track = useStore(audio.store, (state) => playerPlayback(state)?.track);
  const blocked = useStore(audio.store, (state) => state.blocked);
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const [phase, setPhase] = useState<"idle" | "handoff" | "full">("idle");
  const rowHeight = Math.max(
    46,
    Math.ceil(
      (typography.body.lineHeight + typography.caption.lineHeight) * fontScale,
    ),
  );
  const timelineHeight = Math.max(
    30,
    Math.ceil(typography.caption.lineHeight * fontScale),
  );
  const miniHeight =
    insets.top +
    playerPaddingTop +
    rowHeight +
    timelineHeight +
    playerPaddingBottom;
  const progress = useSharedValue(0);
  const miniInFlow = useRef(false);
  const presented = phase !== "idle";
  const setVisible = useCallback(
    (visible: boolean) => {
      if (!visible) {
        setPhase("idle");
        return;
      }
      const next = miniInFlow.current && !reduceMotion ? "handoff" : "full";
      setPhase((current) => (current === "idle" ? next : current));
    },
    [reduceMotion],
  );
  const open = useCallback(() => {
    if (!presented) router.navigate("/audio-player");
  }, [presented]);
  const conversation =
    view === "details" || view === "edit" || view === "call"
      ? undefined
      : /^\/chat\/marmot-([a-f0-9]+)$/u.exec(path)?.[1];
  const eligible =
    !blocked && path !== "/video-player" && showMiniPlayer(track, conversation);
  const reserveMini = eligible && phase === "idle";
  const handoff = phase === "handoff";

  const fullOpacity = useDerivedValue(() => {
    if (phase === "idle") return 0;
    if (!handoff) return 1;
    return interpolate(progress.get(), [0.22, 1], [0, 1], "clamp");
  });
  const miniExit = useAnimatedStyle(() => {
    const value = progress.get();
    return {
      opacity: phase === "full" ? 0 : handoff ? 1 - value : 1,
      transform: [{ translateY: handoff ? -16 * value : 0 }],
    };
  });
  const presentation = useMemo(
    () => ({ setVisible, fullOpacity, miniHeight }),
    [setVisible, fullOpacity, miniHeight],
  );
  useLayoutEffect(() => {
    if (path !== "/audio-player") miniInFlow.current = reserveMini;
  }, [path, reserveMini]);

  const finishHandoff = useCallback(() => {
    setPhase((current) => (current === "handoff" ? "full" : current));
  }, []);
  useLayoutEffect(() => {
    if (phase === "idle") progress.set(0);
    if (!handoff) return;
    progress.set(
      withTiming(1, { duration: 160, easing: Easing.linear }, (finished) => {
        if (finished) scheduleOnRN(finishHandoff);
      }),
    );
    return () => cancelAnimation(progress);
  }, [finishHandoff, handoff, phase, progress]);

  return (
    <View style={[styles.scene, { backgroundColor: colors.background }]}>
      <PlayerPresentation.Provider value={presentation}>
        {children}
      </PlayerPresentation.Provider>
      {eligible && (
        <View
          pointerEvents={presented ? "none" : "box-none"}
          accessibilityElementsHidden={presented}
          importantForAccessibility={presented ? "no-hide-descendants" : "auto"}
          style={[
            styles.miniOverlay,
            {
              paddingTop: insets.top,
              paddingLeft: insets.left + space.sm,
              paddingRight: insets.right + space.sm,
            },
          ]}
        >
          <Animated.View
            entering={
              reduceMotion || presented ? undefined : FadeInUp.duration(170)
            }
            exiting={
              reduceMotion || presented ? undefined : FadeOutUp.duration(150)
            }
          >
            <Animated.View style={miniExit}>
              <MiniPlayer
                open={open}
                rowHeight={rowHeight}
                timelineHeight={timelineHeight}
              />
            </Animated.View>
          </Animated.View>
        </View>
      )}
    </View>
  );
}

export function audioNavigationScene({
  children,
  route,
}: {
  children: ReactNode;
  route: { key: string; name?: string; params?: unknown };
}) {
  if (route.name === "audio-player" || route.name === "video-player")
    return navigationScene({ children });
  const params = route.params;
  const conversation =
    route.name === "chat/[key]" &&
    params &&
    typeof params === "object" &&
    "key" in params &&
    typeof params.key === "string" &&
    (!("view" in params) ||
      !["details", "edit", "call"].includes(String(params.view)))
      ? /^marmot-([a-f0-9]+)$/u.exec(params.key)?.[1]
      : undefined;
  return navigationScene({
    children: conversation ? children : <AudioScene>{children}</AudioScene>,
  });
}

function AudioScene({ children }: { children: ReactNode }) {
  const { miniHeight } = usePlayerPresentation();
  const { audio } = useLocal();
  const insets = useSafeAreaInsets();
  const track = useStore(audio.store, (state) => playerPlayback(state)?.track);
  const blocked = useStore(audio.store, (state) => state.blocked);
  const reserve = !blocked && showMiniPlayer(track);
  return (
    <View style={styles.scene}>
      {reserve && <View style={{ height: miniHeight + space.sm }} />}
      <SafeAreaInsetsContext.Provider
        value={reserve ? { ...insets, top: 0 } : insets}
      >
        {children}
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

function MiniPlayer({
  open,
  rowHeight,
  timelineHeight,
}: {
  open(): void;
  rowHeight: number;
  timelineHeight: number;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation("audio");
  const { audio } = useLocal();
  const current = useStore(audio.store, playerPlayback);
  if (!current) return null;
  const { track, metadata, duration, position, phase } = current;
  const origin = voiceOrigin(track);
  const name = metadata?.title || track.title;
  function details() {
    if (origin) {
      router.navigate({
        pathname: "/chat/[key]",
        params: {
          key: `marmot-${origin[0]}`,
          messageTarget: origin[1],
        },
      });
    } else open();
  }
  return (
    <GlassSurface preset="overlay" elevation="none" style={styles.player}>
      <View style={[styles.row, { height: rowHeight }]}>
        <IconButton
          icon={
            phase === "playing"
              ? "pause"
              : phase === "loading"
                ? "hangup"
                : "play"
          }
          label={t(
            phase === "playing"
              ? "pause"
              : phase === "loading"
                ? "cancel"
                : "play",
          )}
          onPress={audio.player.toggle}
          tone="plain"
          iconColor={colors.accent}
          iconSize={18}
          style={styles.playButton}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(origin ? "goToMessage" : "expanded", {
            title: name,
          })}
          onPress={details}
          style={styles.label}
        >
          <Ink numberOfLines={1}>{name}</Ink>
          {(metadata?.artist ||
            track.subtitle ||
            phase === "loading" ||
            phase === "error") && (
            <Ink muted kind="caption" numberOfLines={1}>
              {phase === "error"
                ? t("unavailable")
                : phase === "loading"
                  ? t("loading")
                  : metadata?.artist || track.subtitle}
            </Ink>
          )}
        </Pressable>
        {track.voice && <SpeedControl />}
        <IconButton
          icon="close"
          label={t("stop")}
          onPress={audio.player.stop}
          tone="plain"
        />
      </View>
      <View style={[styles.timeline, { height: timelineHeight }]}>
        {duration > 0 && (
          <>
            <AudioTimestamp seconds={position} />
            <SeekControl
              compact
              style={styles.seek}
              position={position}
              duration={duration}
              seek={audio.player.seek}
            />
            <AudioTimestamp seconds={duration} />
          </>
        )}
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  scene: { flex: 1 },
  miniOverlay: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 1 },
  player: {
    paddingHorizontal: 10,
    paddingTop: playerPaddingTop,
    paddingBottom: playerPaddingBottom,
    borderRadius: 18,
    gap: 0,
  },
  timeline: {
    flexDirection: "row",
    alignItems: "center",
    direction: "ltr",
    gap: 8,
  },
  seek: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 5 },
  playButton: { width: 36, marginStart: -5 },
  label: { flex: 1, justifyContent: "center", minHeight: 44 },
});
