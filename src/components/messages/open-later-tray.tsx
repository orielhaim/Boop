import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  GlassTray,
  GlassTrayScreen,
  useGlassTray,
} from "@/components/glassyui/glass-tray";
import { MonthCalendar } from "@/components/kinetik/month-calendar";
import { TimeWheel } from "@/components/kinetik/time-wheel";
import { Action, Icon, Ink } from "@/components/ui/kit";
import { maxTimeLockDate } from "@/core/messaging/special-messages/timelock";
import {
  calendarDay,
  defaultUnlockSelection,
  localCalendarDate,
  resolveUnlockSelection,
} from "@/core/messaging/special-messages/unlock-selection";
import { directionFor, resolveLanguage } from "@/i18n";
import { isolateText } from "@/i18n/format";

export function OpenLaterTray({
  openedAt,
  onCancel,
  onSend,
  retryAt,
}: {
  openedAt: number | null;
  onCancel: () => void;
  onSend: (time: number) => void;
  retryAt?: number;
}) {
  const { t, i18n } = useTranslation(["messages", "common"]);
  const locale = resolveLanguage(i18n.resolvedLanguage);
  const rtl = directionFor(locale) === "rtl";
  const { height, fontScale } = useWindowDimensions();
  const open = openedAt !== null;
  const [wasOpen, setWasOpen] = useState(open);
  const [clock, setClock] = useState(() => openedAt ?? Date.now());
  const [selection, setSelection] = useState(() =>
    defaultUnlockSelection(clock),
  );
  const [anchor, setAnchor] = useState(selection.day);
  const settling = useRef(new Set<string>());

  if (wasOpen !== open) {
    setWasOpen(open);
    if (openedAt !== null) {
      const next = defaultUnlockSelection(openedAt);
      setClock(openedAt);
      setSelection(next);
      setAnchor(next.day);
    }
  }

  useEffect(() => {
    if (!open) return;
    settling.current.clear();
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [open]);

  const today = calendarDay(new Date(clock));
  const last = calendarDay(new Date(maxTimeLockDate));
  const start = Math.min(last, selection.day, Math.max(today, anchor - 20));
  const end = Math.min(last, Math.max(selection.day, anchor + 35));
  const dayNames = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    return Array.from({ length: end - start + 1 }, (_, index) => {
      const day = index + start;
      if (day === today) return t("messages:openToday");
      if (day === today + 1) return t("messages:openTomorrow");
      return formatter.format(day * 86_400_000);
    });
  }, [end, locale, start, t, today]);

  const requested = retryAt ?? resolveUnlockSelection(selection, clock);
  const scheduledDate = requested === null ? null : new Date(requested);
  let confirmation: string = t("messages:openLater");
  if (scheduledDate) {
    const day = calendarDay(scheduledDate);
    const label = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(scheduledDate);
    const time = isolateText(label);
    if (day === today) confirmation = t("messages:openTodayAt", { time });
    else if (day === today + 1)
      confirmation = t("messages:openTomorrowAt", { time });
    else {
      const date = new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
      }).format(scheduledDate);
      confirmation = t("messages:openDateAt", {
        date: isolateText(date),
        time,
      });
    }
  }

  function confirm() {
    if (!open || settling.current.size) return;
    const now = Date.now();
    setClock(now);
    const time = retryAt ?? resolveUnlockSelection(selection, now);
    // A timezone change between the last render and the tap updates the
    // confirmation before we send anything.
    if (time !== null && time === requested) onSend(time);
  }

  return (
    <GlassTray
      open={open}
      showHeader={false}
      initialScreen="time"
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <GlassTrayScreen name="time" title={t("messages:openLater")}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          scrollEnabled={height < 650 || fontScale > 1.3}
          contentContainerStyle={styles.body}
        >
          {retryAt === undefined && (
            <>
              <TimeWheel
                compact={height < 650 || fontScale > 1.3}
                value={selection}
                onChange={(change) =>
                  setSelection((value) => ({ ...value, ...change }))
                }
                date={{
                  label: t("messages:openDate"),
                  items: dayNames,
                  index: selection.day - start,
                  onIndex: (index) =>
                    setSelection((value) => ({ ...value, day: start + index })),
                }}
                locale={locale}
                rtl={rtl}
                labels={{
                  hours: t("messages:openHours"),
                  minutes: t("messages:openMinutes"),
                }}
                onSettlingChange={(column, active) => {
                  if (active) settling.current.add(column);
                  else settling.current.delete(column);
                }}
                disabled={!open}
              />
              <CalendarLink
                label={t("messages:openCalendar")}
                canOpen={() => settling.current.size === 0}
              />
            </>
          )}
          {requested === null ? (
            <Ink
              kind="description"
              accessibilityLiveRegion="polite"
              style={styles.error}
            >
              {t("messages:openTimeError")}
            </Ink>
          ) : null}
          <Action
            variant="prominent"
            size="lg"
            style={styles.confirm}
            disabled={!open || requested === null}
            onPress={confirm}
          >
            {retryAt !== undefined
              ? t("messages:openRetryAt", { time: confirmation })
              : confirmation}
          </Action>
        </ScrollView>
      </GlassTrayScreen>
      <GlassTrayScreen name="calendar" title={t("messages:openCalendar")}>
        <CalendarPage
          value={localCalendarDate(selection.day)}
          minDate={new Date(clock)}
          locale={locale}
          rtl={rtl}
          onSelect={(date) => {
            const day = calendarDay(date);
            setAnchor(day);
            setSelection((value) => ({ ...value, day }));
          }}
        />
      </GlassTrayScreen>
    </GlassTray>
  );
}

function CalendarLink({
  label,
  canOpen,
}: {
  label: string;
  canOpen: () => boolean;
}) {
  const tray = useGlassTray();
  return (
    <Action
      variant="ghost"
      onPress={() => {
        if (canOpen()) tray.push("calendar");
      }}
      style={styles.calendarLink}
    >
      <Icon name="calendar" size={18} />
      {label}
    </Action>
  );
}

function CalendarPage({
  value,
  minDate,
  locale,
  rtl,
  onSelect,
}: {
  value: Date;
  minDate: Date;
  locale: string;
  rtl: boolean;
  onSelect: (date: Date) => void;
}) {
  const { pop } = useGlassTray();
  const { t } = useTranslation(["messages", "common"]);
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.body}
    >
      <MonthCalendar
        value={value}
        minDate={minDate}
        maxDate={new Date(maxTimeLockDate)}
        locale={locale}
        rtl={rtl}
        weekStartsOn={rtl ? 0 : 1}
        labels={{
          previous: t("messages:openPreviousMonth"),
          next: t("messages:openNextMonth"),
          today: t("messages:openToday"),
        }}
        onChange={(date) => {
          onSelect(date);
          pop();
        }}
      />
      <Action variant="ghost" style={styles.calendarLink} onPress={pop}>
        {t("common:back")}
      </Action>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.xs,
    paddingBottom: theme.space.md,
  },
  calendarLink: { alignSelf: "center" },
  confirm: { alignSelf: "stretch" },
  error: { color: theme.colors.danger },
}));
