import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { useTranslation } from "react-i18next";
import { Icon, Ink, tapFeedback } from "@/components/ui/kit";
import { directionFor, resolveLanguage } from "@/i18n";
import { motion, radius, useTheme } from "@/theme";
import { dayKey, selectCalendarDay, type DateRange } from "./calendar-range";

type Common = {
  /** The month shown first. Defaults to the selected date's month, or today's. */
  initialMonth?: Date;
  /** Locale used for the month title and accessible date names. */
  locale?: string;
  /** Overrides the locale's text direction. */
  rtl?: boolean;
  labels: { previous: string; next: string; today?: string };
  /** Days before this cannot be chosen. */
  minDate?: Date;
  /** Days after this cannot be chosen. */
  maxDate?: Date;
  /** Days that get a small dot, e.g. days with events. */
  marked?: readonly Date[];
  /** 0 for Sunday, 1 for Monday. Defaults to 1. */
  weekStartsOn?: 0 | 1;
  /** Twelve month names. Defaults to English. */
  monthNames?: readonly string[];
  /** Seven weekday names starting on Sunday. Defaults to English. */
  dayNames?: readonly string[];
  onMonthChange?: (month: Date) => void;
  /** A tick on each choice. Defaults to true. */
  haptics?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export type MonthCalendarProps = Common &
  (
    | { mode?: "single"; value: Date | null; onChange: (date: Date) => void }
    | {
        mode: "range";
        range: DateRange;
        onRangeChange: (range: DateRange) => void;
      }
  );

const CELL = 44;
const DISC = 38;

export const startOfMonth = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), 1);
const sameDay = (a: Date | null | undefined, b: Date | null | undefined) =>
  Boolean(a && b && dayKey(a) === dayKey(b));
const addMonths = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth() + n, 1);

/** The 42 days (six weeks) shown for a month, starting on `weekStartsOn`. */
export function monthGrid(month: Date, weekStartsOn: 0 | 1 = 1): Date[] {
  const first = startOfMonth(month);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  return Array.from(
    { length: 42 },
    (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + i),
  );
}

/**
 * A month of days to pick one date or a range. A disc glides from day to day
 * within the month, a new month slides in from the side you are heading to,
 * and a swipe across the grid turns the page. In range mode a soft band
 * joins the two ends, row by row.
 */
export function MonthCalendar(props: MonthCalendarProps) {
  const {
    initialMonth,
    minDate,
    maxDate,
    marked,
    weekStartsOn = 1,
    monthNames,
    dayNames,
    onMonthChange,
    haptics = true,
    testID,
    style,
  } = props;
  const { colors, reduceMotion } = useTheme();
  const { i18n } = useTranslation();
  const locale = props.locale ?? i18n.resolvedLanguage ?? "en";
  const language = resolveLanguage(locale.split(/[-_]/, 1)[0]);
  const rtl = props.rtl ?? directionFor(language) === "rtl";
  const appRtl = directionFor(resolveLanguage(i18n.resolvedLanguage)) === "rtl";
  const format = useMemo(
    () => ({
      month: new Intl.DateTimeFormat(locale, {
        month: "long",
        year: "numeric",
      }),
      weekday: new Intl.DateTimeFormat(locale, {
        weekday: "short",
        timeZone: "UTC",
      }),
      fullDate: new Intl.DateTimeFormat(locale, { dateStyle: "full" }),
      number: new Intl.NumberFormat(locale, { useGrouping: false }),
    }),
    [locale],
  );
  const weekdays =
    dayNames ??
    Array.from({ length: 7 }, (_, i) =>
      format.weekday.format(new Date(Date.UTC(2020, 5, i + 7))),
    );
  const reduced = reduceMotion;
  const range = props.mode === "range" ? props.range : null;
  const single = props.mode === "range" ? null : props.value;

  const [view, setView] = useState(() => {
    let month = startOfMonth(
      initialMonth ?? single ?? range?.start ?? new Date(),
    );
    if (minDate && month < startOfMonth(minDate)) month = startOfMonth(minDate);
    if (maxDate && month > startOfMonth(maxDate)) month = startOfMonth(maxDate);
    return { month, dir: 0 };
  });
  const [width, setWidth] = useState(0);
  const cw = width / 7;
  const days = monthGrid(view.month, weekStartsOn);
  const today = new Date();
  const markedKeys = new Set((marked ?? []).map(dayKey));
  const lo = minDate ? dayKey(minDate) : -Infinity;
  const hi = maxDate ? dayKey(maxDate) : Infinity;

  const monthAllowed = (month: Date) =>
    (!minDate || addMonths(month, 1) > startOfMonth(minDate)) &&
    (!maxDate || month <= startOfMonth(maxDate));
  const turn = (n: number) => {
    const month = addMonths(view.month, n);
    if (!monthAllowed(month)) return;
    if (haptics) tapFeedback();
    setView({ month, dir: n });
    onMonthChange?.(month);
  };

  const pick = (d: Date) => {
    if (haptics) tapFeedback();
    if (props.mode !== "range") {
      props.onChange(d);
      return;
    }
    props.onRangeChange(selectCalendarDay(props.range, d));
  };

  // The disc for a single date glides within a month and jumps across months.
  const at = single
    ? days.findIndex(
        (d) => sameDay(d, single) && d.getMonth() === view.month.getMonth(),
      )
    : -1;
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const shown = useSharedValue(0);
  const placed = useRef<number | null>(null);
  const monthKey = view.month.getTime();
  useEffect(() => {
    if (at < 0 || cw === 0) {
      shown.set(reduced ? 0 : withTiming(0, { duration: motion.quickFade }));
      placed.current = null;
      return;
    }
    const col = at % 7;
    const tx = (rtl ? 6 - col : col) * cw + (cw - DISC) / 2;
    const ty = Math.floor(at / 7) * CELL + (CELL - DISC) / 2;
    if (reduced || placed.current !== monthKey) {
      x.set(tx);
      y.set(ty);
      shown.set(reduced ? 1 : withSpring(1, motion.press));
    } else {
      x.set(withSpring(tx, motion.travel));
      y.set(withSpring(ty, motion.travel));
      shown.set(1);
    }
    placed.current = monthKey;
  }, [at, cw, monthKey, reduced, rtl, x, y, shown]);
  const disc = useAnimatedStyle(() => ({
    opacity: shown.get(),
    transform: [
      { translateX: x.get() },
      { translateY: y.get() },
      { scale: 0.6 + shown.get() * 0.4 },
    ],
  }));

  const swipe = Gesture.Pan()
    .withTestId("month-calendar")
    .activeOffsetX([-16, 16])
    .failOffsetY([-14, 14])
    .onEnd((e) => {
      if (Math.abs(e.translationX) < 48 && Math.abs(e.velocityX) < 400) return;
      scheduleOnRN(turn, (e.translationX < 0 ? 1 : -1) * (rtl ? -1 : 1));
    });

  const order = Array.from({ length: 7 }, (_, i) => (i + weekStartsOn) % 7);
  const title = monthNames
    ? `${monthNames[view.month.getMonth()]} ${format.number.format(view.month.getFullYear())}`
    : format.month.format(view.month);

  return (
    <View testID={testID} style={style}>
      <View style={[styles.header, { direction: rtl ? "rtl" : "ltr" }]}>
        <Ink
          kind="heading"
          accessibilityRole="header"
          style={styles.monthTitle}
        >
          {title}
        </Ink>
        <View style={styles.arrows}>
          <Arrow
            name="previous"
            label={props.labels.previous}
            enabled={monthAllowed(addMonths(view.month, -1))}
            correction={appRtl !== rtl}
            onPress={() => turn(-1)}
          />
          <Arrow
            name="next"
            label={props.labels.next}
            enabled={monthAllowed(addMonths(view.month, 1))}
            correction={appRtl !== rtl}
            onPress={() => turn(1)}
          />
        </View>
      </View>
      <View style={[styles.week, { direction: rtl ? "rtl" : "ltr" }]}>
        {order.map((d) => (
          <Ink
            key={d}
            accessibilityElementsHidden
            importantForAccessibility="no"
            kind="meta"
            muted
            numberOfLines={1}
            style={styles.weekday}
          >
            {dayNames ? (weekdays[d] ?? "").slice(0, 2) : weekdays[d]}
          </Ink>
        ))}
      </View>
      <GestureDetector gesture={swipe}>
        <View
          collapsable={false}
          style={[styles.gridBox, styles.gridDirection]}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        >
          <Page
            key={monthKey}
            dir={view.dir * (rtl ? -1 : 1)}
            reduced={reduced}
          >
            {range && width > 0 ? (
              <Band
                days={days}
                month={view.month}
                range={range}
                cw={cw}
                rtl={rtl}
                radius={radius.round}
              />
            ) : null}
            {single !== null ? (
              <Animated.View
                pointerEvents="none"
                style={[styles.disc, { backgroundColor: colors.accent }, disc]}
              />
            ) : null}
            <View style={[styles.grid, rtl && styles.rtlRow]}>
              {days.map((d) => {
                const k = dayKey(d);
                const inMonth = d.getMonth() === view.month.getMonth();
                const disabled = !inMonth || k < lo || k > hi;
                const end =
                  range !== null &&
                  (sameDay(d, range.start) || sameDay(d, range.end));
                const chosen =
                  (inMonth && sameDay(d, single)) || (inMonth && end);
                const isToday = sameDay(d, today);
                const name = format.fullDate.format(d);
                return (
                  <Pressable
                    key={k}
                    onPress={() => pick(d)}
                    disabled={disabled}
                    accessibilityRole="button"
                    accessibilityLabel={
                      isToday && props.labels.today
                        ? `${props.labels.today}, ${name}`
                        : name
                    }
                    accessibilityState={{ selected: chosen, disabled }}
                    accessibilityElementsHidden={!inMonth}
                    importantForAccessibility={
                      inMonth ? "auto" : "no-hide-descendants"
                    }
                    style={styles.cell}
                  >
                    <Ink
                      kind="rowTitle"
                      style={{
                        color: chosen
                          ? colors.onAccent
                          : isToday
                            ? colors.accent
                            : colors.text,
                        opacity: !inMonth ? 0.28 : disabled ? 0.4 : 1,
                        fontWeight: chosen || isToday ? "600" : "400",
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {format.number.format(d.getDate())}
                    </Ink>
                    {inMonth && markedKeys.has(k) ? (
                      <View
                        style={[
                          styles.mark,
                          {
                            backgroundColor: chosen
                              ? colors.onAccent
                              : colors.accent,
                          },
                        ]}
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </Page>
        </View>
      </GestureDetector>
    </View>
  );
}

/** A month's grid; a new one slides in from the side being turned to. */
function Page({
  dir,
  reduced,
  children,
}: {
  dir: number;
  reduced: boolean;
  children: ReactNode;
}) {
  const p = useSharedValue(dir === 0 || reduced ? 1 : 0);
  useEffect(() => {
    p.set(withTiming(1, { duration: motion.image }));
  }, [p]);
  const pageStyle = useAnimatedStyle(() => ({
    opacity: p.get(),
    transform: [{ translateX: (1 - p.get()) * 36 * dir }],
  }));
  return <Animated.View style={pageStyle}>{children}</Animated.View>;
}

type BandProps = {
  days: Date[];
  month: Date;
  range: DateRange;
  cw: number;
  rtl: boolean;
  radius: number;
};

/** The range drawn row by row: a soft band between the ends and a disc on each end. */
function Band({ days, month, range, cw, rtl, radius }: BandProps) {
  const { colors } = useTheme();
  if (!range.start) return null;
  const a = dayKey(range.start);
  const b = range.end ? dayKey(range.end) : a;
  const pieces: ReactNode[] = [];
  for (let row = 0; row < 6; row++) {
    const cols: number[] = [];
    for (let c = 0; c < 7; c++) {
      const d = days[row * 7 + c]!;
      const k = dayKey(d);
      if (d.getMonth() === month.getMonth() && k >= a && k <= b) cols.push(c);
    }
    if (cols.length === 0) continue;
    const first = cols[0]!;
    const last = cols[cols.length - 1]!;
    const top = row * CELL + (CELL - DISC) / 2;
    if (range.end && a !== b) {
      pieces.push(
        <View
          key={`band-${row}`}
          style={[
            styles.band,
            {
              top,
              left: (rtl ? 6 - last : first) * cw + (cw - DISC) / 2,
              width: (last - first) * cw + DISC,
              backgroundColor: colors.selected,
              borderRadius: radius,
            },
          ]}
        />,
      );
    }
    for (const c of cols) {
      const k = dayKey(days[row * 7 + c]!);
      if (k === a || k === b) {
        pieces.push(
          <View
            key={`end-${k}`}
            style={[
              styles.band,
              {
                top,
                left: (rtl ? 6 - c : c) * cw + (cw - DISC) / 2,
                width: DISC,
                backgroundColor: colors.accent,
                borderRadius: radius,
              },
            ]}
          />,
        );
      }
    }
  }
  return <>{pieces}</>;
}

function Arrow({
  name,
  label,
  enabled,
  correction,
  onPress,
}: {
  name: "previous" | "next";
  label: string;
  enabled: boolean;
  correction: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      style={({ pressed }) => [
        styles.arrow,
        {
          opacity: enabled ? 1 : 0.35,
          backgroundColor: pressed ? colors.pressed : undefined,
        },
      ]}
    >
      <View style={correction ? { transform: [{ scaleX: -1 }] } : undefined}>
        <Icon name={name} size={18} color={colors.text} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create(({ radius, space }) => ({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.xs,
    marginBottom: space.xs,
  },
  rtlRow: { flexDirection: "row-reverse" },
  monthTitle: { flex: 1 },
  arrows: { flexDirection: "row" },
  arrow: {
    width: 44,
    height: 44,
    borderRadius: radius.round,
    alignItems: "center",
    justifyContent: "center",
  },
  week: { flexDirection: "row", marginBottom: space.xs },
  weekday: { flex: 1, textAlign: "center", paddingVertical: space.sm },
  gridBox: { height: CELL * 6, overflow: "hidden" },
  gridDirection: { direction: "ltr" },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: {
    width: `${100 / 7}%`,
    height: CELL,
    alignItems: "center",
    justifyContent: "center",
  },
  mark: {
    position: "absolute",
    bottom: 6,
    width: 4,
    height: 4,
    borderRadius: radius.round,
  },
  disc: {
    position: "absolute",
    left: 0,
    top: 0,
    width: DISC,
    height: DISC,
    borderRadius: radius.round,
  },
  band: { position: "absolute", height: DISC },
}));
