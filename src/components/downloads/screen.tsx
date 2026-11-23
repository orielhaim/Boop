import { LinearGradient } from "expo-linear-gradient";
import { useNetworkState } from "expo-network";
import { useFocusEffect } from "expo-router";
import {
  memo,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  clamp,
  measure,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { Action, Icon, Ink, Screen, tapFeedback } from "@/components/ui/kit";
import {
  canReorder,
  isPending,
  type DownloadItem,
} from "@/core/downloads/types";
import { marmot } from "@/core/marmot/native";
import { openLocalAttachment } from "@/core/media/open-local-attachment";
import { formatBytes } from "@/i18n/format";
import { useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";

function Progress({ fraction }: { fraction: number }) {
  const { colors, reduceMotion } = useTheme();
  const value = useSharedValue(fraction);
  const style = useAnimatedStyle(() => ({ width: `${value.value * 100}%` }));
  useEffect(() => {
    value.set(withTiming(fraction, { duration: reduceMotion ? 0 : 240 }));
  }, [fraction, reduceMotion, value]);
  return (
    <View style={[styles.track, { backgroundColor: colors.line }]}>
      <Animated.View
        style={[styles.fill, { backgroundColor: colors.accent }, style]}
      />
    </View>
  );
}

const DownloadRow = memo(function DownloadRow({
  job,
  handle,
  offline,
}: {
  job: DownloadItem;
  handle?: ReactNode;
  offline: boolean;
}) {
  const { downloads, lock, privacy, chatPreferences } = useLocal();
  const { t, i18n } = useTranslation("downloads");
  const { colors } = useTheme();
  const locale = i18n.language;
  const fraction = job.total
    ? Math.min(1, job.received / job.total)
    : undefined;
  const bytes = (value: number) => formatBytes(value, locale);
  const unfinished = isPending(job);
  const estimate =
    job.total && job.speed > 0 ? (job.total - job.received) / job.speed : 0;
  const eta =
    estimate >= 60
      ? new Intl.NumberFormat(locale, { style: "unit", unit: "minute" }).format(
          Math.ceil(estimate / 60),
        )
      : new Intl.NumberFormat(locale, { style: "unit", unit: "second" }).format(
          Math.ceil(estimate),
        );
  const details = [
    job.total !== null
      ? job.state === "active" || (unfinished && job.received > 0)
        ? t("bytesOf", {
            received: bytes(job.received),
            total: bytes(job.total),
          })
        : bytes(job.total)
      : job.received > 0
        ? bytes(job.received)
        : null,
    unfinished && job.received > 0 && fraction !== undefined
      ? new Intl.NumberFormat(locale, { style: "percent" }).format(fraction)
      : null,
    job.state === "active" && job.speed > 0 && !offline
      ? t("speed", { size: bytes(job.speed) })
      : null,
    estimate > 0 && !offline ? t("eta", { time: eta }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const state = job.verifying
    ? "verifying"
    : offline && (canReorder(job) || job.state === "active")
      ? "offline"
      : job.state === "active" && job.nativeState === "queued"
        ? "queued"
        : job.state === "active" && job.nativeState === "retry_scheduled"
          ? "waiting"
          : job.state;

  function act(action: "pause" | "cancel" | "remove") {
    void downloads[action](job.id).catch(() => Alert.alert(t("actionFailed")));
  }

  function open() {
    const [group, id] = job.target;
    const authorized = () =>
      !lock.getState().locked &&
      !privacy.isBlocked(job.sender) &&
      !chatPreferences.hidden(group).includes(id) &&
      (job.expiresAt === null || job.expiresAt > Date.now()) &&
      downloads.get(job.id)?.state === "completed";
    void (async () => {
      if (!authorized()) return;
      const file = await marmot.openAttachment(...job.target);
      if (!file) {
        void downloads.reconcile();
        throw new Error("MediaUnavailable");
      }
      try {
        if (authorized()) await openLocalAttachment(file);
      } finally {
        await marmot.releaseAttachment(file.lease);
      }
    })().catch(() => {
      if (authorized()) Alert.alert(t("openFailed"));
    });
  }

  const completed = job.state === "completed";
  const icon = job.type.startsWith("audio/")
    ? "audio"
    : job.type.startsWith("video/")
      ? "camera"
      : job.type.startsWith("image/")
        ? "media"
        : "file";
  const status = job.state === "failed" && job.issue ? t(job.issue) : t(state);
  const primary = completed
    ? ({ icon: "continue", label: t("open"), run: open } as const)
    : job.state === "active" || canReorder(job)
      ? ({ icon: "pause", label: t("pause"), run: () => act("pause") } as const)
      : ({
          icon: job.state === "paused" ? "play" : "refresh",
          label: t(job.state === "paused" ? "resume" : "retry"),
          run: () => {
            try {
              downloads.resume(job.id);
            } catch {
              Alert.alert(t("actionFailed"));
            }
          },
        } as const);

  const summary = (
    <>
      <View style={[styles.file, { backgroundColor: colors.accentSoft }]}>
        <Icon name={icon} size={20} />
      </View>
      <View style={styles.copy}>
        <Ink kind="label" numberOfLines={1}>
          {job.name || t("open")}
        </Ink>
        <Ink
          kind="caption"
          numberOfLines={job.state === "failed" ? 2 : 1}
          style={{
            color: job.state === "failed" ? colors.danger : colors.muted,
          }}
        >
          {status}
        </Ink>
        {details ? (
          <Ink kind="caption" muted numberOfLines={1} style={styles.numbers}>
            {details}
          </Ink>
        ) : null}
        {unfinished && fraction !== undefined && fraction > 0 ? (
          <Progress fraction={fraction} />
        ) : null}
      </View>
    </>
  );

  return (
    <View
      style={[
        styles.row,
        { backgroundColor: colors.surface, borderColor: colors.line },
      ]}
    >
      {handle}
      {completed ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t("open")}, ${job.name}`}
          style={styles.info}
          onPress={() => {
            tapFeedback();
            open();
          }}
        >
          {summary}
        </Pressable>
      ) : (
        <View style={styles.info}>{summary}</View>
      )}
      {!completed && (
        <RowButton
          icon={primary.icon}
          label={primary.label}
          onPress={primary.run}
        />
      )}
      <RowButton
        icon={unfinished ? "hangup" : "erase"}
        label={t(unfinished ? "cancel" : "remove")}
        onPress={() => {
          if (unfinished) act("cancel");
          else if (completed)
            Alert.alert(t("removeTitle"), t("removeDetail"), [
              { text: t("cancel", { ns: "common" }), style: "cancel" },
              {
                text: t("remove"),
                style: "destructive",
                onPress: () => act("remove"),
              },
            ]);
          else act("remove");
        }}
      />
    </View>
  );
});

function RowButton({
  icon,
  label,
  onPress,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        pressed && { backgroundColor: colors.accentSoft },
      ]}
    >
      <Icon name={icon} size={19} />
    </Pressable>
  );
}

type Drag = {
  from: SharedValue<number>;
  translation: SharedValue<number>;
  scroll: SharedValue<number>;
  startScroll: SharedValue<number>;
  finger: SharedValue<number>;
  settling: SharedValue<boolean>;
  viewport: SharedValue<{ top: number; height: number }>;
  to: SharedValue<number>;
};

function SortableDownload({
  job,
  index,
  height,
  drag,
  offline,
  onPick,
  onDrop,
  onRelease,
  onMeasure,
  onPlace,
}: {
  job: DownloadItem;
  index: number;
  height: number;
  drag: Drag;
  offline: boolean;
  onPick: () => void;
  onDrop: (id: string, target: number) => void;
  onRelease: () => void;
  onPlace: (id: string, target: number) => void;
  onMeasure: () => void;
}) {
  const { t } = useTranslation("downloads");
  const { reduceMotion, colors } = useTheme();
  const { scroll, startScroll, translation, from, to, finger, settling } = drag;
  const pan = Gesture.Pan()
    .activateAfterLongPress(280)
    .onStart(({ absoluteY }) => {
      "worklet";
      if (from.value >= 0) return;
      onMeasure();
      startScroll.set(scroll.value);
      translation.set(0);
      finger.set(absoluteY);
      from.set(index);
      scheduleOnRN(onPick);
    })
    .onUpdate(({ translationY, absoluteY }) => {
      "worklet";
      if (from.value !== index) return;
      translation.set(translationY);
      finger.set(absoluteY);
    })
    .onEnd((_event, success) => {
      "worklet";
      if (!success || from.value !== index) return;
      const destination = to.value;
      const offset =
        (destination - index) * height + startScroll.value - scroll.value;
      settling.set(true);
      translation.set(
        withTiming(offset, { duration: reduceMotion ? 0 : 145 }, (finished) => {
          if (finished && from.value === index)
            scheduleOnRN(onPlace, job.id, destination);
        }),
      );
    })
    .onFinalize(() => {
      "worklet";
      if (from.value !== index || settling.value) return;
      from.set(-1);
      scheduleOnRN(onRelease);
    });
  const motion = useAnimatedStyle(() => {
    const lifted = index === from.value;
    let shift = 0;
    if (from.value >= 0) {
      if (index > from.value && index <= to.value) shift = -height;
      if (index < from.value && index >= to.value) shift = height;
    }
    return {
      zIndex: lifted ? 2 : 0,
      elevation: lifted ? 7 : 0,
      transform: [
        {
          translateY: lifted
            ? translation.value + scroll.value - startScroll.value
            : withTiming(shift, { duration: reduceMotion ? 0 : 170 }),
        },
        {
          scale: withTiming(lifted && !reduceMotion ? 1.025 : 1, {
            duration: reduceMotion ? 0 : 150,
          }),
        },
      ],
    };
  });

  const handle = (
    <GestureDetector gesture={pan}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t("reorder", { name: job.name })}
        accessibilityActions={[
          { name: "decrement", label: t("moveUp") },
          { name: "increment", label: t("moveDown") },
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          onDrop(
            job.id,
            index + (nativeEvent.actionName === "increment" ? 1 : -1),
          );
        }}
        style={styles.button}
      >
        <Icon name="reorder" size={20} color={colors.muted} />
      </View>
    </GestureDetector>
  );
  return (
    <Animated.View style={[{ height, paddingBottom: space.sm }, motion]}>
      <DownloadRow job={job} handle={handle} offline={offline} />
    </Animated.View>
  );
}

export function DownloadsScreen() {
  const { downloads } = useLocal();
  const { t, i18n } = useTranslation("downloads");
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const { isConnected } = useNetworkState();
  const rows = useSyncExternalStore(downloads.subscribe, downloads.snapshot);
  const active = rows.filter((job) => job.state === "active");
  const queue = rows.filter(canReorder);
  const editable = queue.length >= 2;
  const paused = rows.filter((job) => job.state === "paused");
  const history = rows
    .filter((job) => !isPending(job))
    .sort((a, b) => b.changedAt - a.changedAt);
  const [historyLimit, setHistoryLimit] = useState(40);
  const offline = isConnected === false;
  const bytes = (value: number) => formatBytes(value, i18n.language);
  const speed = active.reduce((sum, item) => sum + item.speed, 0);
  const pending = [...active, ...queue, ...paused];
  const remaining = pending.reduce(
    (sum, row) => sum + Math.max(0, (row.total ?? 0) - row.received),
    0,
  );
  const rowHeight = Math.max(94, 45 * fontScale + 45);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scroll = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  const from = useSharedValue(-1);
  const translation = useSharedValue(0);
  const startScroll = useSharedValue(0);
  const finger = useSharedValue(0);
  const settling = useSharedValue(false);
  const viewport = useSharedValue({ top: 0, height: 0 });
  const count = queue.length;
  const to = useDerivedValue(() =>
    clamp(
      from.value +
        Math.round(
          (translation.value + scroll.value - startScroll.value) / rowHeight,
        ),
      0,
      Math.max(0, count - 1),
    ),
  );
  const drag = {
    from,
    translation,
    scroll,
    startScroll,
    finger,
    viewport,
    settling,
    to,
  };
  const scrollHandler = useAnimatedScrollHandler(({ contentOffset }) => {
    scroll.set(contentOffset.y);
  });

  const autoScroll = useFrameCallback(({ timeSincePreviousFrame }) => {
    if (
      from.value < 0 ||
      settling.value ||
      !viewport.value.height ||
      timeSincePreviousFrame == null
    )
      return;
    const position = finger.value - viewport.value.top;
    const edge = 58;
    const intensity =
      position < edge
        ? -clamp((edge - position) / edge, 0, 1)
        : clamp((position - viewport.value.height + edge) / edge, 0, 1);
    if (!intensity) return;
    const next = clamp(
      scroll.value + intensity * Math.min(28, timeSincePreviousFrame) * 0.45,
      0,
      Math.max(0, contentHeight.value - viewport.value.height),
    );
    if (next !== scroll.value) scrollTo(scrollRef, 0, next, false);
  }, false);
  const setAutoScroll = autoScroll.setActive;
  const pick = useCallback(() => {
    downloads.setReordering(true);
    setAutoScroll(true);
    tapFeedback();
  }, [downloads, setAutoScroll]);
  const release = useCallback(() => {
    setAutoScroll(false);
    from.set(-1);
    settling.set(false);
    downloads.setReordering(false);
  }, [downloads, from, setAutoScroll, settling]);

  useFocusEffect(
    useCallback(() => {
      void downloads.reconcile();
      return release;
    }, [downloads, release]),
  );

  function drop(id: string, position: number) {
    const available = downloads.snapshot().filter(canReorder);
    const current = available.findIndex((item) => item.id === id);
    if (
      position < 0 ||
      position >= available.length ||
      position === current ||
      current < 0
    )
      return;
    available.splice(current, 1);
    try {
      downloads.reorder(id, available[position]?.id);
      tapFeedback();
    } catch {
      Alert.alert(t("actionFailed"));
    }
  }

  return (
    <Screen
      scroll={false}
      navigationHeader={<ScreenHeader title={t("title")} />}
    >
      <Animated.ScrollView
        ref={scrollRef}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        onContentSizeChange={(_width, height) => {
          contentHeight.set(height);
        }}
        contentContainerStyle={styles.content}
      >
        {rows.length === 0 ? (
          <View style={styles.empty}>
            <View
              style={[styles.emptyIcon, { backgroundColor: colors.accentSoft }]}
            >
              <Icon name="download" size={30} />
            </View>
            <Ink kind="heading">{t("empty")}</Ink>
            <Ink muted style={styles.center}>
              {t("emptyDetail")}
            </Ink>
          </View>
        ) : (
          <>
            {active.length + queue.length + paused.length > 0 && (
              <LinearGradient
                colors={[colors.heroStart, colors.heroEnd]}
                style={[styles.hero, { borderColor: colors.line }]}
              >
                <Icon name="download" size={26} />
                <Ink kind="heading" accessibilityRole="header">
                  {t("activity")}
                </Ink>
                <Ink kind="label">
                  {[
                    t("activeCount", { count: active.length }),
                    t("pendingCount", { count: queue.length + paused.length }),
                    speed > 0 && !offline
                      ? t("speed", { size: bytes(speed) })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Ink>
                {remaining > 0 &&
                  pending.every((job) => job.total !== null) && (
                    <Ink kind="caption" muted>
                      {t("remaining", { size: bytes(remaining) })}
                    </Ink>
                  )}
              </LinearGradient>
            )}
            {active.map((job) => (
              <DownloadRow key={job.id} job={job} offline={offline} />
            ))}
            {queue.length + paused.length > 0 && (
              <Ink
                kind="heading"
                accessibilityRole="header"
                style={styles.section}
              >
                {t("queue")}
              </Ink>
            )}
            <View>
              {queue.map((job, index) =>
                editable ? (
                  <SortableDownload
                    key={job.id}
                    job={job}
                    index={index}
                    height={rowHeight}
                    drag={drag}
                    onPick={pick}
                    onDrop={drop}
                    onPlace={(id, position) => {
                      try {
                        drop(id, position);
                      } finally {
                        release();
                      }
                    }}
                    onRelease={release}
                    offline={offline}
                    onMeasure={() => {
                      "worklet";
                      const bounds = measure(scrollRef);
                      if (bounds)
                        viewport.set({
                          top: bounds.pageY,
                          height: bounds.height,
                        });
                    }}
                  />
                ) : (
                  <DownloadRow key={job.id} job={job} offline={offline} />
                ),
              )}
            </View>
            {paused.map((job) => (
              <DownloadRow key={job.id} job={job} offline={offline} />
            ))}
            {history.length > 0 && (
              <>
                <Ink
                  kind="heading"
                  accessibilityRole="header"
                  style={styles.section}
                >
                  {t("history")}
                </Ink>
                {history.slice(0, historyLimit).map((job) => (
                  <DownloadRow key={job.id} job={job} offline={offline} />
                ))}
                {historyLimit < history.length && (
                  <Action
                    variant="soft"
                    onPress={() => setHistoryLimit((count) => count + 40)}
                  >
                    {t("more")}
                  </Action>
                )}
              </>
            )}
          </>
        )}
      </Animated.ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
    gap: space.sm,
  },
  hero: {
    borderWidth: 1,
    borderRadius: 24,
    padding: space.lg,
    gap: space.xs,
    marginBottom: space.sm,
  },
  section: { marginTop: space.md, marginBottom: space.xs },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 80,
    flexGrow: 1,
    borderWidth: 1,
    borderRadius: 19,
    paddingStart: 4,
    paddingEnd: 3,
  },
  info: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.sm,
  },
  file: {
    marginStart: space.xs,
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  button: {
    width: 44,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  track: { height: 3, borderRadius: 2, overflow: "hidden", marginTop: 4 },
  fill: { height: 3, borderRadius: 2 },
  numbers: { fontVariant: ["tabular-nums"] },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    paddingBottom: space.xxl,
  },
  emptyIcon: {
    width: 66,
    height: 66,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.sm,
  },
  center: { textAlign: "center" },
});
