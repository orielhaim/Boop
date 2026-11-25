import { memo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { useAnimatedRef } from "react-native-reanimated";
import Sortable from "react-native-sortables";
import { useStore } from "zustand";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { ActionMenu } from "@/components/ui/action-menu";
import { Action, Icon, Ink } from "@/components/ui/kit";
import { playerPlayback } from "@/core/audio/controller";
import { trackId, type Track } from "@/core/audio/types";
import { formatDuration } from "@/i18n/format";
import { useLocal } from "@/services/local-context";
import { useAppPreferences } from "@/stores/preferences";
import { space, useTheme } from "@/theme";
import { useAudioActions } from "./actions";
import { TrackMark } from "./controls";

export const QueueSheet = memo(function QueueSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { audio } = useLocal();
  const { t } = useTranslation("audio");
  const { colors, reduceMotion } = useTheme();
  const current = useStore(
    audio.store,
    (state) => playerPlayback(state)?.track,
  );
  const upcoming = useStore(audio.store, (state) => state.upcoming);
  const scroll = useAnimatedRef<Animated.ScrollView>();
  const haptics = useAppPreferences((state) => state.haptics);
  return (
    <GlassSheet open={open} onOpenChange={onOpenChange}>
      <GlassSheetContent closeLabel={t("closeQueue")}>
        <GlassSheetTitle>{t("queue")}</GlassSheetTitle>
        <GestureHandlerRootView style={styles.gestures}>
          <Animated.ScrollView
            ref={scroll}
            style={styles.scroll}
            contentContainerStyle={styles.content}
          >
            {current && (
              <>
                <Ink muted kind="caption">
                  {t("nowPlaying")}
                </Ink>
                <QueueRow track={current} current />
              </>
            )}
            <View style={styles.section}>
              <Ink muted kind="caption">
                {t("upNext")}
              </Ink>
              {upcoming.length > 0 && (
                <Action size="sm" variant="ghost" onPress={audio.clear}>
                  {t("clear")}
                </Action>
              )}
            </View>
            {upcoming.length === 0 ? (
              <Ink muted>{t("emptyQueue")}</Ink>
            ) : (
              <Sortable.Flex
                flexDirection="column"
                customHandle
                scrollableRef={scroll}
                dragActivationDelay={160}
                hapticsEnabled={haptics}
                activeItemScale={reduceMotion ? 1 : 1.025}
                gap={space.xs}
                onDragEnd={({ fromIndex, toIndex }) => {
                  const track = upcoming[fromIndex];
                  if (track) audio.reorder(trackId(track), toIndex);
                }}
              >
                {upcoming.map((track, index) => (
                  <QueueRow
                    key={trackId(track)}
                    track={track}
                    handle={
                      <Sortable.Handle>
                        <View
                          style={styles.button}
                          accessible
                          accessibilityRole="adjustable"
                          accessibilityLabel={t("reorder", {
                            title: track.title,
                          })}
                          accessibilityValue={{
                            min: 1,
                            max: upcoming.length,
                            now: index + 1,
                          }}
                          accessibilityActions={[
                            { name: "decrement", label: t("earlier") },
                            { name: "increment", label: t("later") },
                          ]}
                          onAccessibilityAction={({ nativeEvent }) =>
                            audio.reorder(
                              trackId(track),
                              index +
                                (nativeEvent.actionName === "increment"
                                  ? 1
                                  : -1),
                            )
                          }
                        >
                          <Icon name="reorder" color={colors.muted} size={20} />
                        </View>
                      </Sortable.Handle>
                    }
                  />
                ))}
              </Sortable.Flex>
            )}
          </Animated.ScrollView>
        </GestureHandlerRootView>
        <PickAudioForQueue />
      </GlassSheetContent>
    </GlassSheet>
  );
});

function PickAudioForQueue() {
  const { t } = useTranslation("audio");
  const { pick } = useAudioActions();
  return (
    <Action variant="soft" onPress={() => void pick(true)}>
      {t("queueDevice")}
    </Action>
  );
}

const QueueRow = memo(function QueueRow({
  track,
  current,
  handle,
}: {
  track: Track;
  current?: boolean;
  handle?: React.ReactNode;
}) {
  const { audio } = useLocal();
  const { t } = useTranslation("audio");
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.row,
        { backgroundColor: current ? colors.selected : colors.raised },
      ]}
    >
      {handle ?? (
        <View style={styles.button}>
          <TrackMark voice={track.voice} size={20} />
        </View>
      )}
      <View style={styles.title}>
        <Ink numberOfLines={2}>{track.title}</Ink>
        {track.duration ? (
          <Ink muted kind="caption">
            {formatDuration(track.duration)}
          </Ink>
        ) : null}
      </View>
      <ActionMenu
        label={t("trackActions", { title: track.title })}
        actions={[
          ...(!current ? [{ id: "next", title: t("playNext") }] : []),
          { id: "remove", title: t("remove") },
        ]}
        onSelect={(action) => {
          if (action === "next") audio.enqueue(track, true);
          else if (action === "remove") audio.remove(trackId(track));
        }}
      >
        <View style={styles.button}>
          <Icon name="more" size={20} />
        </View>
      </ActionMenu>
    </View>
  );
});

const styles = StyleSheet.create({
  gestures: { alignSelf: "stretch" },
  scroll: { maxHeight: 380 },
  content: { gap: 8, paddingBottom: 8 },
  section: {
    minHeight: 38,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 13,
    minHeight: 52,
  },
  title: { flex: 1, gap: 3 },
  button: {
    width: 44,
    minHeight: 48,
    justifyContent: "center",
    alignItems: "center",
  },
});
