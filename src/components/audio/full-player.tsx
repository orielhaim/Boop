import { Image } from "expo-image";
import {
  router,
  useFocusEffect,
  useIsFocused,
  useLocalSearchParams,
} from "expo-router";
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useScreenAnimation } from "react-native-screen-transitions";
import { useStore } from "zustand";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { Action, IconButton, Ink, Screen } from "@/components/ui/kit";
import { playerPlayback } from "@/core/audio/controller";
import { useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";
import { useAudioActions } from "./actions";
import { AudioTime, SeekControl, SpeedControl, TrackMark } from "./controls";
import { QueueSheet } from "./queue-sheet";
import { usePlayerPresentation } from "./presentation";

const GooeyText = lazy(() => import("./effects/molecules/gooey-text"));
const RippleImage = lazy(() => import("./effects/organisms/skia-ripple"));

export function FullPlayer() {
  const { audio, audioSources } = useLocal();
  const { t } = useTranslation("audio");
  const { colors, reduceMotion } = useTheme();
  const { setVisible, fullOpacity } = usePlayerPresentation();
  const animation = useScreenAnimation();
  const entrance = useAnimatedStyle(() => ({
    opacity:
      reduceMotion || animation.get().current.closing ? 1 : fullOpacity.get(),
  }));
  const measured = useRef(false);
  const focused = useIsFocused();
  useFocusEffect(
    useCallback(() => {
      if (measured.current) setVisible(true);
      return () => setVisible(false);
    }, [setVisible]),
  );
  const [artwork, setArtwork] = useState({ width: 0, height: 0 });
  const { pick, open } = useAudioActions();
  const [queue, setQueue] = useState(false);
  const { incomingAudio } = useLocalSearchParams<{ incomingAudio?: string }>();
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(false);
  async function importAudio(uri: string) {
    if (importing) return;
    setImporting(true);
    setImportError(false);
    try {
      const track = await audioSources.importContent(uri);
      router.setParams({ incomingAudio: undefined });
      await open(track, "internal");
    } catch {
      setImportError(true);
    } finally {
      setImporting(false);
    }
  }
  const blocked = useStore(audio.store, (state) => state.blocked);
  const active = useStore(audio.store, playerPlayback);
  const nextCount = useStore(audio.store, (state) => state.upcoming.length);
  const queued = useStore(audio.store, (state) => state.upcoming[0]);
  const shuffle = useStore(audio.store, (state) => state.shuffle);
  const repeat = useStore(audio.store, (state) => state.repeat);
  const title = active?.metadata?.title || active?.track.title;
  const subtitle = active?.metadata?.artist || active?.track.subtitle;
  return (
    <Animated.View style={[styles.entrance, entrance]}>
      <Screen
        compact
        navigationHeader={
          <ScreenHeader
            title={t("nowPlaying")}
            showBack={false}
            action={
              <IconButton
                icon="expand"
                label={t("minimize")}
                onPress={() => {
                  if (router.canGoBack()) router.back();
                  else router.replace("/profile");
                }}
              />
            }
          />
        }
      >
        <View
          style={styles.content}
          onLayout={() => {
            measured.current = true;
            if (focused) setVisible(true);
          }}
        >
          {incomingAudio && (
            <GlassSurface
              style={styles.importPrompt}
              preset="subtle"
              elevation="none"
            >
              <Ink>{t("incomingFile")}</Ink>
              <View style={styles.actions}>
                <Action
                  disabled={blocked || importing}
                  onPress={() => void importAudio(incomingAudio)}
                >
                  {t("internal")}
                </Action>
                <Action
                  variant="ghost"
                  disabled={importing}
                  onPress={() => router.setParams({ incomingAudio: undefined })}
                >
                  {t("dismissImport")}
                </Action>
              </View>
              {importError && (
                <Ink style={{ color: colors.danger }}>{t("unavailable")}</Ink>
              )}
            </GlassSurface>
          )}
          <GlassSurface
            style={[styles.artwork, { backgroundColor: colors.selected }]}
            elevation="none"
            preset="subtle"
            onLayout={({ nativeEvent }) =>
              setArtwork({
                width: nativeEvent.layout.width,
                height: nativeEvent.layout.height,
              })
            }
          >
            {active?.metadata?.artworkUrl ? (
              <>
                <Image
                  source={active.metadata.artworkUrl}
                  recyclingKey={active.metadata.artworkUrl}
                  cachePolicy="none"
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                />
                {!reduceMotion && artwork.width > 0 && artwork.height > 0 && (
                  <Suspense fallback={null}>
                    <RippleImage
                      uri={active.metadata.artworkUrl}
                      width={artwork.width}
                      height={artwork.height}
                    />
                  </Suspense>
                )}
              </>
            ) : (
              <TrackMark voice={active?.track.voice} size={72} />
            )}
          </GlassSurface>
          {active ? (
            <>
              <View style={styles.description}>
                <View style={styles.titleRegion}>
                  <Suspense fallback={<TrackTitle text={title ?? ""} />}>
                    {reduceMotion ? (
                      <TrackTitle text={title ?? ""} />
                    ) : (
                      <GooeyText text={title ?? ""} />
                    )}
                  </Suspense>
                </View>
                {subtitle && (
                  <Ink muted numberOfLines={2}>
                    {subtitle}
                  </Ink>
                )}
                {active.metadata?.album && (
                  <Ink muted kind="caption" numberOfLines={2}>
                    {active.metadata.album}
                  </Ink>
                )}
              </View>
              <View>
                <SeekControl
                  position={active.position}
                  duration={active.duration}
                  seek={audio.player.seek}
                />
                <AudioTime elapsed={active.position} total={active.duration} />
              </View>
              <View style={styles.transport}>
                <IconButton
                  icon="skipPrevious"
                  label={t("previous")}
                  disabled={blocked}
                  onPress={() => void audio.player.previous()}
                  tone="plain"
                />
                <Action
                  variant="prominent"
                  accessibilityLabel={t(
                    active.phase === "playing"
                      ? "pause"
                      : active.phase === "loading"
                        ? "cancel"
                        : "play",
                  )}
                  disabled={blocked}
                  onPress={audio.player.toggle}
                >
                  {t(
                    active.phase === "playing"
                      ? "pause"
                      : active.phase === "loading"
                        ? "cancel"
                        : "play",
                  )}
                </Action>
                <IconButton
                  icon="skipNext"
                  label={t("next")}
                  disabled={blocked}
                  onPress={() => void audio.player.next()}
                  tone="plain"
                />
              </View>
              {active.phase === "loading" && (
                <ActivityIndicator
                  accessibilityLabel={t("loading")}
                  color={colors.accent}
                />
              )}
              {active.phase === "error" && (
                <View style={styles.description}>
                  <Ink
                    accessibilityLiveRegion="polite"
                    style={{ color: colors.danger }}
                  >
                    {t("unavailable")}
                  </Ink>
                  {!active.track.voice && (
                    <Action
                      variant="ghost"
                      onPress={() => void open(active.track, "external")}
                    >
                      {t("external")}
                    </Action>
                  )}
                </View>
              )}
              {blocked && <Ink muted>{t("focusPaused")}</Ink>}
            </>
          ) : (
            <Ink muted>{t("emptyPlayer")}</Ink>
          )}
          <View style={styles.transport}>
            <IconButton
              icon="shuffle"
              label={t(shuffle ? "shuffleOn" : "shuffleOff")}
              tone={shuffle ? "accent" : "plain"}
              onPress={audio.toggleShuffle}
            />
            <IconButton
              icon={repeat === "one" ? "repeatOne" : "repeat"}
              label={t(
                repeat === "one"
                  ? "repeatOne"
                  : repeat === "all"
                    ? "repeatAll"
                    : "repeatOff",
              )}
              tone={repeat === "off" ? "plain" : "accent"}
              onPress={audio.cycleRepeat}
            />
            {active && <SpeedControl player />}
            <IconButton
              icon="reorder"
              label={t("queueCount", { count: nextCount })}
              onPress={() => setQueue(true)}
            />
          </View>
          {queued && (
            <Action variant="ghost" onPress={() => setQueue(true)}>
              {t("nextTitle", { title: queued.title })}
            </Action>
          )}
          <View style={styles.actions}>
            <Action onPress={() => void pick()} disabled={blocked}>
              {t("openDevice")}
            </Action>
            {active && (
              <Action variant="ghost" onPress={audio.player.stop}>
                {t("stop")}
              </Action>
            )}
          </View>
        </View>
        <QueueSheet open={queue} onOpenChange={setQueue} />
      </Screen>
    </Animated.View>
  );
}

function TrackTitle({ text }: { text: string }) {
  return (
    <Ink
      kind="title"
      accessibilityRole="header"
      numberOfLines={3}
      style={styles.title}
    >
      {text}
    </Ink>
  );
}

const styles = StyleSheet.create({
  entrance: { flex: 1 },
  titleRegion: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 380,
    paddingHorizontal: space.md,
  },
  title: { textAlign: "center" },
  content: {
    gap: space.lg,
    alignSelf: "center",
    width: "100%",
    maxWidth: 420,
    paddingBottom: space.xl,
  },
  artwork: {
    alignSelf: "center",
    width: "90%",
    maxWidth: 310,
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: 30,
  },
  description: { gap: 5 },
  importPrompt: { padding: 14, gap: 8 },
  transport: {
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "center",
    flexWrap: "wrap",
  },
  actions: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
});
