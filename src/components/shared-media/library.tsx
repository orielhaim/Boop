import { useNavigation } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
  type FlatListProps,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  LinearTransition,
  type ScrollHandlerProcessed,
  useAnimatedScrollHandler,
  useComposedEventHandler,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { GlassTray, GlassTrayScreen } from "@/components/glassyui/glass-tray";
import {
  emptyDateRange,
  type DateRange,
} from "@/components/kinetik/calendar-range";
import { MonthCalendar } from "@/components/kinetik/month-calendar";
import { usePresentedName } from "@/components/people/use-person";
import { ForwardMessage } from "@/components/messages/marmot-message-tools";
import { QuietState } from "@/components/ui/messenger-ui";
import { GooeySearchTabs } from "@/components/ui/gooey-search-tabs";
import {
  Shimmer,
  useShimmerProgress,
} from "@/components/ui/molecules/Shimmer/Shimmer";
import {
  Action,
  Empty,
  Icon,
  IconButton,
  Ink,
  Row,
  tapFeedback,
  type IconName,
} from "@/components/ui/kit";
import { downloadId } from "@/core/downloads/types";
import {
  type MarmotMessage,
  type SharedMediaQuery,
  type SharedMediaRow,
} from "@/core/marmot/native";
import {
  mediaCategory,
  mediaKey,
  mediaTarget,
  type MediaCategory,
} from "@/core/marmot/shared-media";
import { directionFor, resolveLanguage } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { radius, space, useTheme } from "@/theme";
import { SharedMediaItem, SharedMediaViewer } from "./items";
import { useLibrary } from "./use-library";
import { maxMediaSelection, useLibraryActions } from "./library-actions";

const categories = [
  ["visual", "media"],
  ["files", "file"],
  ["music", "audio"],
  ["voice", "microphone"],
] as const satisfies readonly [MediaCategory, IconName][];
type VisualFilter = "all" | "photos" | "videos";
type SenderPreset = "anySender" | "sent" | "received";
type SenderFilter = SenderPreset | { key: string };
export type SharedMediaScope =
  | { kind: "account" }
  | { kind: "group"; group: string }
  | { kind: "direct"; group: string | null | undefined };
type ListRow =
  | { kind: "controls"; key: "controls" }
  | { kind: "month"; key: string; title: string }
  | { kind: "items"; key: string; rows: SharedMediaRow[]; month: string };
const controls: ListRow = { kind: "controls", key: "controls" };
const gridReflow = LinearTransition.duration(220);

function dateQuery({ start, end }: DateRange) {
  if (!start) return {};
  const last = end ?? start;
  return {
    after:
      new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate(),
      ).getTime() / 1000,
    before:
      new Date(
        last.getFullYear(),
        last.getMonth(),
        last.getDate() + 1,
      ).getTime() /
        1000 -
      1,
  };
}

function listRows(
  items: readonly SharedMediaRow[],
  columns: number,
  locale: string,
) {
  const result: ListRow[] = [controls];
  const format = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
  });
  let monthKey = "";
  let month = "";
  let line: Extract<ListRow, { kind: "items" }> | undefined;
  for (const row of items) {
    const date = new Date(row.at * 1_000);
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    if (key !== monthKey) {
      month = format.format(date);
      result.push({ kind: "month", key: `month:${key}`, title: month });
      monthKey = key;
      line = undefined;
    }
    if (!line || line.rows.length === columns) {
      line = { kind: "items", key: mediaKey(row), rows: [], month };
      result.push(line);
    }
    line.rows.push(row);
  }
  return result;
}

export function SharedMediaLibrary({
  scope,
  header,
  tabs,
  onAnimatedScroll,
  scrollPositionRef,
  active = true,
  showLoadingPlaceholder = true,
}: {
  scope: SharedMediaScope;
  header?: ReactNode;
  tabs?: ReactNode;
  onAnimatedScroll?: ScrollHandlerProcessed;
  scrollPositionRef?: { current: number };
  active?: boolean;
  showLoadingPlaceholder?: boolean;
}) {
  const { t, i18n } = useTranslation(["messages", "common", "downloads"]);
  const locale = resolveLanguage(i18n.resolvedLanguage);
  const rtl = directionFor(locale) === "rtl";
  const { colors, reduceMotion } = useTheme();
  const { bottom } = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { downloads, identity, marmotSession } = useLocal();
  const navigation = useNavigation();
  const [category, setCategory] = useState<MediaCategory>("visual");
  const [visualFilter, setVisualFilter] = useState<VisualFilter>("all");
  const [senderFilter, setSenderFilter] = useState<SenderFilter>("anySender");
  const [downloadedOnly, setDownloadedOnly] = useState(false);
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [conversation, setConversation] = useState<string>();
  const [dateRange, setDateRange] = useState<DateRange>(emptyDateRange);
  const [tray, setTray] = useState<"filters" | "calendar">();
  const [density, setDensity] = useState(1);
  const columns =
    category === "visual"
      ? [2, 3, 5][density] + (width >= 700 ? 2 : width >= 560 ? 1 : 0)
      : 1;
  const group =
    scope.kind === "account" ? undefined : (scope.group ?? undefined);
  const hasHistoryScope = scope.kind === "account" || group !== undefined;
  const baseQuery = useMemo(
    () => (hasHistoryScope ? { group } : undefined),
    [group, hasHistoryScope],
  );
  const sender =
    typeof senderFilter === "object" ? senderFilter.key : undefined;
  const senderKey = senderFilter === "sent" ? identity.publicKey : sender;
  const query = useMemo<SharedMediaQuery | undefined>(() => {
    return conversation || senderKey || dateRange.start
      ? {
          group: group ?? conversation,
          sender: senderKey,
          ...dateQuery(dateRange),
        }
      : undefined;
  }, [conversation, dateRange, group, senderKey]);
  const {
    state,
    rows,
    browseRows,
    browseMore,
    collection,
    presentation,
    interactive,
    unavailable,
    waiting,
  } = useLibrary(baseQuery, query, active);
  const downloadLayout = useSyncExternalStore(
    downloads.subscribe,
    downloads.layout,
  );
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const downloaded = useMemo(
    () =>
      new Set(
        downloadLayout.flatMap((job) =>
          job.state === "completed" ? [job.id] : [],
        ),
      ),
    [downloadLayout],
  );
  const hasLocal = useCallback(
    (row: SharedMediaRow) =>
      downloaded.has(downloadId(mediaTarget(row))) ||
      (row.local && !removed.has(downloadId(mediaTarget(row)))),
    [downloaded, removed],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filterChoices, setFilterChoices] = useState(24);
  const [viewer, setViewer] = useState<string>();
  const [forwarding, setForwarding] = useState<{
    row: SharedMediaRow;
    message: MarmotMessage;
  }>();
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());
  const [floatingDate, setFloatingDate] = useState("");
  const [scrubbing, setScrubbing] = useState(false);
  const [railHeight, setRailHeight] = useState(1);
  const list = useRef<FlatList<ListRow>>(null);
  const offset = useRef(0);
  const categoryOffsets = useRef(new Map<string, number>());
  const headerHeight = useRef(0);
  const controlsHeight = useRef(0);
  const previousView = useRef<string>(undefined);
  const focusItem = useRef<string>(undefined);
  const automaticPages = useRef({ key: "", count: 0 });
  const viewKey = JSON.stringify([
    category,
    visualFilter,
    senderFilter,
    downloadedOnly,
    term,
    query,
  ]);
  const historyRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          mediaCategory(row) === category &&
          (category !== "visual" ||
            visualFilter !== "photos" ||
            row.category === "image") &&
          (category !== "visual" ||
            visualFilter !== "videos" ||
            row.category === "video") &&
          (!downloadedOnly || hasLocal(row)) &&
          (senderFilter !== "received" || row.sender !== identity.publicKey) &&
          (!term ||
            row.item.name.toLocaleLowerCase(locale).includes(term) ||
            row.caption.toLocaleLowerCase(locale).includes(term)),
      ),
    [
      category,
      downloadedOnly,
      hasLocal,
      identity.publicKey,
      locale,
      rows,
      senderFilter,
      term,
      visualFilter,
    ],
  );
  const data = useMemo(
    () => listRows(historyRows, columns, locale),
    [columns, historyRows, locale],
  );
  const datesInList = useMemo(
    () =>
      data.flatMap((row, index) =>
        row.kind === "month" ? [{ index, title: row.title }] : [],
      ),
    [data],
  );
  const locationNames = useMemo(
    () =>
      new Map(
        [...browseRows, ...rows].flatMap((row) =>
          row.groupLabel ? [[row.group, row.groupLabel] as const] : [],
        ),
      ),
    [browseRows, rows],
  );
  const knownSenders = useMemo(() => {
    if (scope.kind === "direct") return [];
    return [
      ...new Set([...browseRows, ...rows].map((row) => row.sender)),
    ].filter((key) => key !== identity.publicKey);
  }, [browseRows, identity.publicKey, rows, scope.kind]);
  const batch = useMemo(
    () => rows.filter((row) => selected.has(downloadId(mediaTarget(row)))),
    [rows, selected],
  );
  const restrictedVisual = category === "visual" && visualFilter !== "all";
  const hasFilters =
    restrictedVisual ||
    senderFilter !== "anySender" ||
    downloadedOnly ||
    Boolean(conversation || dateRange.start);
  const hasSearch = Boolean(term) || hasFilters;
  const senderName = usePresentedName(sender ?? "");
  const senderPresets: readonly SenderPreset[] =
    scope.kind === "group"
      ? ["anySender", "sent"]
      : ["anySender", "sent", "received"];
  const appliedFilters = [
    restrictedVisual && t(`messages:sharedMedia.${visualFilter}`),
    downloadedOnly && t("messages:sharedMedia.downloaded"),
    senderFilter !== "anySender" &&
      (typeof senderFilter === "object"
        ? senderName
        : t(`messages:sharedMedia.${senderFilter}`)),
    conversation &&
      (locationNames.get(conversation) ??
        t("messages:sharedMedia.conversation")),
    dateRange.start &&
      [dateRange.start, dateRange.end]
        .filter((day) => day !== null)
        .map((day) => day.toLocaleDateString(locale))
        .join(" – "),
  ].filter(Boolean);

  useEffect(() => {
    const timeout = setTimeout(
      () => setTerm(text.trim().toLocaleLowerCase(locale)),
      220,
    );
    return () => clearTimeout(timeout);
  }, [locale, text]);
  if (
    viewer &&
    (!interactive || !historyRows.some((row) => mediaKey(row) === viewer))
  )
    setViewer(undefined);
  if (!interactive) {
    if (selected.size) setSelected(new Set());
    if (tray) setTray(undefined);
    if (forwarding) setForwarding(undefined);
  }
  useEffect(() => {
    if (!interactive || !selected.size || viewer || tray) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      setSelected(new Set());
      return true;
    });
    return () => back.remove();
  }, [interactive, selected.size, tray, viewer]);
  useEffect(() => {
    if (automaticPages.current.key !== viewKey)
      automaticPages.current = { key: viewKey, count: 0 };
    if (
      interactive &&
      collection &&
      state.phase === "ready" &&
      state.more &&
      historyRows.length < columns * 2 &&
      automaticPages.current.count < 3
    ) {
      automaticPages.current.count++;
      const timer = setTimeout(() => void collection.next(), 80);
      return () => clearTimeout(timer);
    }
  }, [
    collection,
    columns,
    historyRows.length,
    interactive,
    state.more,
    state.phase,
    viewKey,
  ]);
  useEffect(() => {
    const restored =
      categoryOffsets.current.get(viewKey) ??
      (previousView.current
        ? Math.min(offset.current, headerHeight.current)
        : (scrollPositionRef?.current ?? 0));
    previousView.current = viewKey;
    const frame = requestAnimationFrame(() =>
      list.current?.scrollToOffset({ offset: restored, animated: false }),
    );
    return () => cancelAnimationFrame(frame);
  }, [scrollPositionRef, viewKey]);
  useEffect(() => {
    if (!focusItem.current) return;
    const index = data.findIndex(
      (row) =>
        row.kind === "items" &&
        row.rows.some((item) => mediaKey(item) === focusItem.current),
    );
    focusItem.current = undefined;
    if (index > 0)
      list.current?.scrollToIndex({
        index,
        animated: !reduceMotion,
        viewPosition: 0.3,
      });
  }, [data, reduceMotion]);

  const onVisible = useCallback<
    NonNullable<FlatListProps<ListRow>["onViewableItemsChanged"]>
  >(({ viewableItems }) => {
    const lines = viewableItems.flatMap(({ item }) =>
      item.kind === "items" ? [item] : [],
    );
    setVisible(
      new Set(lines.flatMap((line) => line.rows.map(mediaKey)).slice(0, 10)),
    );
    if (lines[0]) setFloatingDate(lines[0].month);
  }, []);
  const changeDensity = useCallback(
    (step: number, focalX?: number, focalY?: number) => {
      const next = Math.max(0, Math.min(2, density + step));
      if (next === density) return;
      const current = historyRows.filter((row) => visible.has(mediaKey(row)));
      const column =
        focalX == null
          ? 0
          : Math.floor((rtl ? width - focalX : focalX) / (width / columns));
      const line =
        focalY == null
          ? 0
          : Math.max(
              0,
              Math.floor((focalY - controlsHeight.current) / (width / columns)),
            );
      const position = line * columns + column;
      const anchor =
        current[Math.max(0, Math.min(position, current.length - 1))];
      focusItem.current = anchor && mediaKey(anchor);
      tapFeedback();
      setDensity(next);
    },
    [columns, density, historyRows, rtl, visible, width],
  );
  const pinch = Gesture.Pinch()
    .enabled(category === "visual" && !batch.length)
    // Gesture Handler invokes this callback after a native gesture.
    // eslint-disable-next-line react-hooks/refs
    .onEnd((event) => {
      if (event.scale < 0.82)
        scheduleOnRN(changeDensity, 1, event.focalX, event.focalY);
      if (event.scale > 1.22)
        scheduleOnRN(changeDensity, -1, event.focalX, event.focalY);
    });
  const lastScrub = useRef(-1);
  const scrubDate = useCallback(
    (fraction: number) => {
      const index = Math.max(
        0,
        Math.min(
          datesInList.length - 1,
          Math.floor(fraction * datesInList.length),
        ),
      );
      const month = datesInList[index];
      if (!month || lastScrub.current === index) return;
      lastScrub.current = index;
      setFloatingDate(month.title);
      list.current?.scrollToIndex({
        index: month.index,
        animated: false,
        viewPosition: 0,
        viewOffset: controlsHeight.current,
      });
      tapFeedback();
    },
    [datesInList],
  );
  const finishScrub = () => {
    lastScrub.current = -1;
    setScrubbing(false);
  };
  const scrub = Gesture.Pan()
    // Gesture callbacks read scroll state only in response to native input.
    // eslint-disable-next-line react-hooks/refs
    .onBegin((event) => {
      scheduleOnRN(setScrubbing, true);
      scheduleOnRN(scrubDate, event.y / railHeight);
    })
    // eslint-disable-next-line react-hooks/refs
    .onUpdate((event) => scheduleOnRN(scrubDate, event.y / railHeight))
    // eslint-disable-next-line react-hooks/refs
    .onFinalize(() => scheduleOnRN(finishScrub));

  function toggle(row: SharedMediaRow) {
    const id = downloadId(mediaTarget(row));
    tapFeedback();
    setSelected((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else if (next.size < maxMediaSelection) next.add(id);
      return next;
    });
  }
  const {
    batchBusy,
    batchRun,
    confirmRemove,
    download,
    open,
    playVideo,
    saveBatch,
    showMenu,
    fail,
  } = useLibraryActions({
    presentation,
    interactive,
    hasLocal,
    onView: (row) => setViewer(mediaKey(row)),
    onCloseViewer: () => setViewer(undefined),
    onForward: (row, message) => setForwarding({ row, message }),
    onRemoved(row) {
      setRemoved(
        (previous) => new Set([...previous, downloadId(mediaTarget(row))]),
      );
      void collection?.refresh();
    },
    onBatchComplete: () => setSelected(new Set()),
  });
  const savable = batch.filter(
    (row) =>
      hasLocal(row) &&
      (Platform.OS === "android" ||
        row.category === "image" ||
        row.category === "video"),
  );
  function reset() {
    setDateRange(emptyDateRange);
    setConversation(undefined);
    setSenderFilter("anySender");
    setVisualFilter("all");
    setDownloadedOnly(false);
  }

  const categoryBar = (
    <View
      style={styles.controls}
      onLayout={({ nativeEvent }) => {
        controlsHeight.current = nativeEvent.layout.height;
      }}
    >
      {tabs}
      <View style={styles.categorySearch}>
        <GooeySearchTabs
          activeTab={category}
          onTabChange={(value) => {
            const next = categories.find(([key]) => key === value)?.[0];
            if (!next || next === category) return;
            setSelected(new Set());
            setCategory(next);
          }}
          value={text}
          onChange={(value) => setText(value.slice(0, 128))}
          onSearch={(value) => setTerm(value.trim().toLocaleLowerCase(locale))}
          placeholder={t("messages:sharedMedia.search")}
        >
          <GooeySearchTabs.Trigger>
            <Icon name="search" size={19} color={colors.text} />
          </GooeySearchTabs.Trigger>
          <GooeySearchTabs.Tabs>
            {categories.map(([value, icon]) => (
              <GooeySearchTabs.Tab
                key={value}
                value={value}
                accessibilityLabel={t(`messages:sharedMedia.${value}`)}
              >
                <GooeySearchTabs.TabIcon>
                  <Icon
                    name={icon}
                    size={15}
                    color={category === value ? colors.accent : colors.muted}
                  />
                </GooeySearchTabs.TabIcon>
                <GooeySearchTabs.TabLabel>
                  {t(`messages:sharedMedia.${value}`)}
                </GooeySearchTabs.TabLabel>
              </GooeySearchTabs.Tab>
            ))}
          </GooeySearchTabs.Tabs>
        </GooeySearchTabs>
      </View>
      <View style={styles.libraryTools}>
        {hasFilters && (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.applied}
              contentContainerStyle={styles.appliedLabels}
            >
              {appliedFilters.map((label, index) => (
                <Ink key={index} kind="caption" muted numberOfLines={1}>
                  {label}
                </Ink>
              ))}
            </ScrollView>
            <IconButton
              icon="close"
              label={t("messages:sharedMedia.reset")}
              onPress={reset}
              iconSize={16}
            />
          </>
        )}
        <IconButton
          icon="filters"
          label={t("messages:sharedMedia.filters")}
          tone={hasFilters ? "accent" : "plain"}
          onPress={() => setTray("filters")}
          iconSize={18}
        />
        <IconButton
          icon="calendar"
          label={t("messages:sharedMedia.calendar")}
          tone={dateRange.start ? "accent" : "plain"}
          onPress={() => setTray("calendar")}
          iconSize={18}
        />
      </View>
    </View>
  );
  function recordScroll(y: number) {
    offset.current = y;
    if (
      !categoryOffsets.current.has(viewKey) &&
      categoryOffsets.current.size >= 24
    ) {
      const oldest = categoryOffsets.current.keys().next().value;
      if (oldest) categoryOffsets.current.delete(oldest);
    }
    categoryOffsets.current.set(viewKey, y);
    if (scrollPositionRef) scrollPositionRef.current = y;
  }

  const recordAnimatedScroll = useAnimatedScrollHandler({
    onScroll(event, context: { time?: number }) {
      const time = performance.now();
      if (context.time === undefined || time - context.time >= 64) {
        context.time = time;
        scheduleOnRN(recordScroll, event.contentOffset.y);
      }
    },
    onEndDrag(event) {
      scheduleOnRN(recordScroll, event.contentOffset.y);
    },
    onMomentumEnd(event) {
      scheduleOnRN(recordScroll, event.contentOffset.y);
    },
  });
  const animatedScroll = useComposedEventHandler([
    onAnimatedScroll ?? null,
    recordAnimatedScroll,
  ]);

  return (
    <View style={[styles.root, { direction: rtl ? "rtl" : "ltr" }]}>
      <GestureDetector gesture={pinch}>
        <Animated.FlatList<ListRow>
          itemLayoutAnimation={reduceMotion ? undefined : gridReflow}
          ref={list}
          style={styles.root}
          ListHeaderComponent={
            header ? (
              <View
                onLayout={({ nativeEvent }) => {
                  headerHeight.current = nativeEvent.layout.height;
                }}
              >
                {header}
              </View>
            ) : undefined
          }
          data={data}
          keyExtractor={(row) => row.key}
          stickyHeaderIndices={[header ? 1 : 0]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{
            paddingBottom: bottom + (batch.length ? 82 : space.xl),
          }}
          maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
          initialNumToRender={10}
          maxToRenderPerBatch={9}
          windowSize={7}
          onViewableItemsChanged={onVisible}
          onScroll={
            onAnimatedScroll
              ? animatedScroll
              : (event) => recordScroll(event.nativeEvent.contentOffset.y)
          }
          scrollEventThrottle={onAnimatedScroll ? 16 : 64}
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            list.current?.scrollToOffset({
              offset: Math.max(
                0,
                index * averageItemLength - controlsHeight.current,
              ),
              animated: false,
            });
          }}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (
              interactive &&
              state.phase === "ready" &&
              historyRows.length &&
              state.more
            )
              void collection?.next();
          }}
          renderItem={({ item }) => {
            if (item.kind === "controls")
              return hasHistoryScope ? categoryBar : tabs;
            if (item.kind === "month")
              return (
                <Ink
                  kind="section"
                  accessibilityRole="header"
                  style={styles.month}
                >
                  {item.title}
                </Ink>
              );
            return (
              <View style={category === "visual" ? styles.grid : styles.list}>
                {item.rows.map((row) => (
                  <View
                    key={mediaKey(row)}
                    style={
                      category === "visual"
                        ? { width: `${100 / columns}%`, padding: 1 }
                        : undefined
                    }
                  >
                    <SharedMediaItem
                      row={row}
                      grid={category === "visual"}
                      selected={selected.has(downloadId(mediaTarget(row)))}
                      selection={Boolean(batch.length)}
                      visible={interactive && visible.has(mediaKey(row))}
                      groupLabel={
                        group
                          ? undefined
                          : (row.groupLabel ??
                            t("messages:sharedMedia.conversation"))
                      }
                      presentation={presentation}
                      onPress={() => (batch.length ? toggle(row) : open(row))}
                      onLongPress={() => toggle(row)}
                      onMenu={() => showMenu(row)}
                    />
                  </View>
                ))}
              </View>
            );
          }}
          ListFooterComponent={
            unavailable || (interactive && state.phase === "error") ? (
              <Empty
                icon="warning"
                detail=""
                title={t("messages:sharedMedia.unavailable")}
              >
                <Action
                  size="sm"
                  variant="soft"
                  onPress={() =>
                    void (collection?.next() ?? marmotSession.retry())
                  }
                >
                  {t("common:retry")}
                </Action>
              </Empty>
            ) : !hasHistoryScope ? (
              scope.kind === "direct" && scope.group === null ? (
                <View style={styles.empty}>
                  <QuietState
                    icon="media"
                    title={t("messages:sharedMedia.empty")}
                  />
                </View>
              ) : undefined
            ) : !interactive && !waiting ? undefined : state.phase ===
              "loading" ? (
              historyRows.length ? (
                <View
                  style={styles.loading}
                  accessibilityLabel={t("common:checking")}
                >
                  <ActivityIndicator color={colors.accent} />
                </View>
              ) : showLoadingPlaceholder || hasSearch ? (
                <LibrarySkeleton
                  columns={columns}
                  grid={category === "visual"}
                  rtl={rtl}
                  label={t("common:checking")}
                  interactive={interactive}
                />
              ) : undefined
            ) : state.more ? (
              <View style={styles.loading}>
                {hasSearch && (
                  <Ink kind="caption" muted>
                    {t("messages:sharedMedia.partial")}
                  </Ink>
                )}
                <Action
                  size="sm"
                  variant="soft"
                  onPress={() => void collection?.next()}
                >
                  {t("messages:marmot.loadMore")}
                </Action>
              </View>
            ) : !historyRows.length ? (
              <View style={styles.empty}>
                <QuietState
                  icon={
                    categories.find(([value]) => value === category)?.[1] ??
                    "media"
                  }
                  title={t(
                    hasSearch
                      ? "messages:sharedMedia.noMatches"
                      : "messages:sharedMedia.empty",
                  )}
                  detail={t(
                    hasSearch
                      ? "messages:sharedMedia.noMatchesHint"
                      : "messages:sharedMedia.emptyHint",
                  )}
                />
              </View>
            ) : undefined
          }
        />
      </GestureDetector>
      {interactive &&
        datesInList.length > 1 &&
        category === "visual" &&
        !viewer &&
        !tray && (
          <GestureDetector gesture={scrub}>
            <View
              onLayout={(event) =>
                setRailHeight(Math.max(1, event.nativeEvent.layout.height))
              }
              accessibilityRole="adjustable"
              accessibilityLabel={t("messages:sharedMedia.scrollByMonth")}
              accessibilityActions={[
                { name: "increment" },
                { name: "decrement" },
              ]}
              onAccessibilityAction={({ nativeEvent }) => {
                const current = datesInList.findIndex(
                  ({ title }) => title === floatingDate,
                );
                scrubDate(
                  (current +
                    (nativeEvent.actionName === "increment" ? 1 : -1)) /
                    datesInList.length,
                );
              }}
              style={styles.scrub}
            >
              <View style={styles.rail} />
            </View>
          </GestureDetector>
        )}
      {scrubbing && !!floatingDate && (
        <View pointerEvents="none" style={styles.floatingDate}>
          <Ink kind="control">{floatingDate}</Ink>
        </View>
      )}
      {interactive && batch.length > 0 && (
        <View style={[styles.selection, { bottom: bottom + space.sm }]}>
          <IconButton
            icon="close"
            label={t("common:cancel")}
            onPress={() => setSelected(new Set())}
          />
          <Ink kind="control" style={styles.selectionLabel}>
            {t("messages:sharedMedia.selected", { count: batch.length })}
          </Ink>
          {batch.some((row) => !hasLocal(row)) && (
            <IconButton
              disabled={batchBusy}
              icon="download"
              label={t("messages:sharedMedia.download")}
              onPress={() =>
                void batchRun(
                  batch.filter((row) => !hasLocal(row)),
                  download,
                )
              }
            />
          )}
          {!!savable.length && (
            <IconButton
              disabled={batchBusy}
              icon="storage"
              label={t("messages:mediaSave")}
              onPress={() => void saveBatch(savable).catch(fail)}
            />
          )}
          {batch.some(hasLocal) && (
            <IconButton
              disabled={batchBusy}
              icon="trash"
              label={t("messages:sharedMedia.removeCopy")}
              onPress={() => confirmRemove(batch.filter(hasLocal))}
            />
          )}
          {batch.length === 1 && (
            <IconButton
              disabled={batchBusy}
              icon="more"
              label={t("messages:sharedMedia.moreActions")}
              onPress={() => showMenu(batch[0], undefined, true)}
            />
          )}
        </View>
      )}
      <GlassTray
        presentation="sheet"
        open={interactive && (tray != null || forwarding != null)}
        initialScreen={forwarding ? "forward" : (tray ?? "filters")}
        onOpenChange={(shown) => {
          if (!shown) {
            setTray(undefined);
            setForwarding(undefined);
          }
        }}
      >
        <GlassTrayScreen
          name="filters"
          title={t("messages:sharedMedia.filters")}
        >
          <ScrollView
            style={styles.filterTray}
            contentContainerStyle={styles.filterBody}
          >
            {category === "visual" && (
              <View style={styles.filterChips}>
                {(["all", "photos", "videos"] as const).map((value) => (
                  <FilterChip
                    key={value}
                    label={t(`messages:sharedMedia.${value}`)}
                    selected={visualFilter === value}
                    onPress={() => setVisualFilter(value)}
                  />
                ))}
              </View>
            )}
            <View style={styles.filterChips}>
              {senderPresets.map((value) => (
                <FilterChip
                  key={value}
                  label={t(`messages:sharedMedia.${value}`)}
                  selected={senderFilter === value}
                  onPress={() => setSenderFilter(value)}
                />
              ))}
              <FilterChip
                label={t("messages:sharedMedia.downloaded")}
                selected={downloadedOnly}
                onPress={() => setDownloadedOnly((value) => !value)}
              />
            </View>
            {category === "visual" && (
              <Row
                title={t("messages:sharedMedia.grid", { count: columns })}
                leading={<Icon name="media" />}
                onPress={() => changeDensity(density === 2 ? -2 : 1)}
              />
            )}
            {knownSenders.length > 0 && (
              <Ink kind="section">{t("messages:sharedMedia.sender")}</Ink>
            )}
            {knownSenders.slice(0, filterChoices).map((key) => (
              <SenderRow
                key={key}
                sender={key}
                selected={sender === key}
                onPress={() =>
                  setSenderFilter(sender === key ? "anySender" : { key })
                }
              />
            ))}
            {!group && locationNames.size > 0 && (
              <Ink kind="section">{t("messages:sharedMedia.conversation")}</Ink>
            )}
            {!group &&
              [...locationNames]
                .slice(0, filterChoices)
                .map(([key, name]) => (
                  <Row
                    key={key}
                    title={name}
                    leading={
                      <Icon name={conversation === key ? "check" : "chat"} />
                    }
                    onPress={() =>
                      setConversation(conversation === key ? undefined : key)
                    }
                  />
                ))}
            {scope.kind !== "direct" &&
              (browseMore ||
                knownSenders.length > filterChoices ||
                (!group && locationNames.size > filterChoices)) && (
                <Action
                  size="sm"
                  variant="soft"
                  onPress={() => {
                    setFilterChoices((count) => count + 24);
                    void browseMore?.();
                  }}
                >
                  {t(
                    scope.kind === "group"
                      ? "messages:sharedMedia.olderSenders"
                      : "messages:sharedMedia.olderFilters",
                  )}
                </Action>
              )}
            {hasFilters && (
              <Action size="sm" variant="soft" onPress={reset}>
                {t("messages:sharedMedia.reset")}
              </Action>
            )}
          </ScrollView>
        </GlassTrayScreen>
        <GlassTrayScreen
          name="calendar"
          title={t("messages:sharedMedia.calendar")}
        >
          <View style={styles.filterBody}>
            <MonthCalendar
              mode="range"
              range={dateRange}
              locale={locale}
              rtl={rtl}
              weekStartsOn={rtl ? 0 : 1}
              maxDate={new Date()}
              marked={browseRows
                .slice(0, 160)
                .map((row) => new Date(row.at * 1000))}
              labels={{
                previous: t("messages:openPreviousMonth"),
                next: t("messages:openNextMonth"),
                today: t("messages:openToday"),
              }}
              onRangeChange={setDateRange}
            />
          </View>
        </GlassTrayScreen>
        <GlassTrayScreen
          name="forward"
          title={t("messages:sharedMedia.forwardFile")}
        >
          {forwarding && (
            <ForwardMessage
              group={forwarding.row.group}
              row={forwarding.message}
              onlyAttachment={forwarding.row.item.index}
              canDispatch={() =>
                navigation.isFocused() &&
                Boolean(presentation.authorize(mediaTarget(forwarding.row)))
              }
              onClose={() => setForwarding(undefined)}
            />
          )}
        </GlassTrayScreen>
      </GlassTray>
      {interactive && viewer && (
        <SharedMediaViewer
          rows={historyRows}
          selected={viewer}
          presentation={presentation}
          more={state.more}
          onClose={() => setViewer(undefined)}
          onMenu={showMenu}
          onPlay={playVideo}
          groupLabel={
            group
              ? undefined
              : (row) =>
                  row.groupLabel ?? t("messages:sharedMedia.conversation")
          }
          onDownload={(row) => void download(row).catch(fail)}
          onMore={() => {
            if (state.phase === "ready" && state.more) void collection?.next();
          }}
        />
      )}
    </View>
  );
}

function LibrarySkeleton({
  columns,
  grid,
  rtl,
  label,
  interactive,
}: {
  columns: number;
  grid: boolean;
  rtl: boolean;
  label: string;
  interactive: boolean;
}) {
  const { colors, reduceMotion } = useTheme();
  const animate = interactive && !reduceMotion;
  const progress = useShimmerProgress(animate);
  const shape = {
    background: colors.recessed,
    highlight: colors.selected,
    rtl,
    progress: animate ? progress : undefined,
  };
  return (
    <View
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
      style={styles.skeleton}
    >
      {Array.from({ length: 2 }, (_, line) => (
        <View
          key={line}
          style={grid ? styles.grid : styles.skeletonRow}
          importantForAccessibility="no-hide-descendants"
        >
          {Array.from({ length: columns }, (_, cell) => (
            <View
              key={cell}
              style={grid ? { flex: 1, padding: 1 } : styles.search}
            >
              <Shimmer
                {...shape}
                style={
                  grid
                    ? { aspectRatio: 1, borderRadius: 5 }
                    : { width: "100%", height: 60, borderRadius: radius.small }
                }
              />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function FilterChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Ink kind="control" style={selected && styles.activeInk}>
        {label}
      </Ink>
    </Pressable>
  );
}

function SenderRow({
  sender,
  selected,
  onPress,
}: {
  sender: string;
  selected: boolean;
  onPress(): void;
}) {
  const name = usePresentedName(sender);
  return (
    <Row
      title={name}
      leading={<Icon name={selected ? "check" : "person"} />}
      onPress={onPress}
    />
  );
}

const styles = StyleSheet.create(({ colors }) => ({
  root: { flex: 1, backgroundColor: colors.background },
  controls: {
    backgroundColor: colors.background,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  categorySearch: { paddingHorizontal: space.md, paddingTop: space.xs },
  libraryTools: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    paddingHorizontal: space.lg,
    gap: space.xs,
  },
  chip: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.round,
  },
  chipSelected: { backgroundColor: colors.selected },
  activeInk: { color: colors.accent },
  search: { flex: 1 },
  applied: { flex: 1, minWidth: 0 },
  appliedLabels: {
    alignItems: "center",
    gap: space.sm,
  },
  month: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  grid: { flexDirection: "row" },
  list: { paddingHorizontal: space.lg },
  loading: {
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
  },
  empty: { paddingHorizontal: space.lg, paddingTop: space.xxl },
  skeleton: { paddingTop: space.md },
  skeletonRow: { marginHorizontal: space.lg, marginBottom: space.sm },
  filterTray: { maxHeight: 400 },
  filterBody: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
  },
  filterChips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  scrub: {
    position: "absolute",
    end: 0,
    top: "27%",
    bottom: "17%",
    width: 24,
    alignItems: "flex-end",
    justifyContent: "center",
    paddingEnd: 3,
  },
  rail: {
    width: 4,
    height: 44,
    borderRadius: radius.round,
    backgroundColor: colors.accent,
  },
  floatingDate: {
    position: "absolute",
    end: space.xl,
    top: "43%",
    borderRadius: radius.round,
    backgroundColor: colors.raised,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  selection: {
    position: "absolute",
    start: space.md,
    end: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.sm,
    backgroundColor: colors.raised,
    borderRadius: radius.group,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  selectionLabel: { flex: 1 },
}));
