import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, ScrollView, View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetDescription,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { Action, Ink } from "@/components/ui/kit";
import {
  maxTimeLockDate,
  scheduleUnlock,
} from "@/core/messaging/special-messages/timelock";
import { resolveLanguage } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { useTheme } from "@/theme";

const quickChoices = [
  ["openInFive", 5],
  ["openInHour", 60],
  ["openTomorrow", "tomorrow"],
] as const;

function quickDate(choice: number | "tomorrow") {
  const date = new Date(Math.ceil(Date.now() / 1_000) * 1_000);
  if (choice === "tomorrow") date.setDate(date.getDate() + 1);
  else return new Date(date.getTime() + choice * 60_000);
  return date;
}

export function OpenLaterSheet({
  open,
  onCancel,
  onSend,
  busy,
  error,
  colorScheme,
  rtl,
}: {
  open: boolean;
  onCancel: () => void;
  onSend: (time: number) => void;
  busy: boolean;
  error?: string;
  colorScheme: "dark" | "light";
  rtl: boolean;
}) {
  const { t, i18n } = useTranslation(["messages", "common"]);
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  const language = resolveLanguage(i18n.resolvedLanguage);
  const [choice, setChoice] = useState<
    (typeof quickChoices)[number][1] | "custom"
  >(5);
  const [date, setDate] = useState(() => quickDate(5));
  const [now, setNow] = useState(Date.now);
  const [custom, setCustom] = useState<{ mode: "date" | "time"; date: Date }>();
  const requested = date.getTime();
  const valid =
    Number.isFinite(requested) &&
    requested > now &&
    requested <= maxTimeLockDate;
  const schedule = valid ? scheduleUnlock(requested) : null;
  const format = (time: number) =>
    formatDateTime(time, language, undefined, true);
  const latest = new Date(maxTimeLockDate);
  const earliest = new Date(now);

  useEffect(() => {
    if (!open || !valid) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(
        1,
        Math.min(requested - Math.max(now, Date.now()), 2_147_000_000),
      ),
    );
    return () => clearTimeout(timer);
  }, [open, valid, requested, now]);

  function selectDate(value: Date) {
    setNow(Date.now());
    setChoice("custom");
    setDate(value);
  }

  return (
    <GlassSheet
      open={open}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <GlassSheetContent closeLabel={t("messages:cancel")}>
        <GlassSheetTitle>{t("messages:openLater")}</GlassSheetTitle>
        <ScrollView
          style={{ maxHeight: Math.max(120, Math.min(560, height - 160)) }}
          contentContainerStyle={styles.sheet}
          keyboardShouldPersistTaps="handled"
        >
          <GlassSheetDescription>
            {t("messages:openLaterExplanation")}
          </GlassSheetDescription>
          <View style={[styles.choices, { direction: rtl ? "rtl" : "ltr" }]}>
            {quickChoices.map(([label, value]) => (
              <Action
                key={value}
                size="sm"
                variant={choice === value ? "soft" : "ghost"}
                disabled={busy}
                accessibilityState={{ selected: choice === value }}
                onPress={() => {
                  setChoice(value);
                  setNow(Date.now());
                  setDate(quickDate(value));
                  setCustom(undefined);
                }}
              >
                {t(`messages:${label}`)}
              </Action>
            ))}
          </View>
          <Action
            variant="soft"
            disabled={busy}
            onPress={() => setCustom({ mode: "date", date })}
          >
            {t("messages:openChooseTime")}
          </Action>
          {open && custom && Platform.OS === "android" ? (
            <DateTimePicker
              key={custom.mode}
              mode={custom.mode}
              value={custom.date}
              minimumDate={earliest}
              maximumDate={latest}
              themeVariant={colorScheme}
              accentColor={colors.accent}
              positiveButton={{ label: t("common:done") }}
              negativeButton={{ label: t("messages:cancel") }}
              onDismiss={() => setCustom(undefined)}
              onValueChange={(_, value) => {
                if (custom.mode === "date")
                  setCustom({ mode: "time", date: value });
                else {
                  value.setSeconds(0, 0);
                  selectDate(value);
                  setCustom(undefined);
                }
              }}
            />
          ) : open && custom ? (
            <DateTimePicker
              mode="datetime"
              display="inline"
              value={date}
              minimumDate={earliest}
              maximumDate={latest}
              locale={language}
              themeVariant={colorScheme}
              accentColor={colors.accent}
              disabled={busy}
              onValueChange={(_, value) => {
                value.setSeconds(0, 0);
                selectDate(value);
              }}
            />
          ) : null}
          <View
            style={[styles.selection, { backgroundColor: colors.selected }]}
          >
            <Ink style={styles.strong}>
              {Number.isFinite(requested)
                ? t("messages:openSelectedTime", { time: format(requested) })
                : t("messages:openTimeError")}
            </Ink>
            {schedule && schedule.roundTime !== requested ? (
              <Ink kind="caption" muted>
                {t("messages:openRoundTime", {
                  time: format(schedule.roundTime),
                })}
              </Ink>
            ) : null}
          </View>
          {error || !valid ? (
            <Ink kind="caption" accessibilityLiveRegion="polite">
              {error ?? t("messages:openTimeError")}
            </Ink>
          ) : null}
          <Action
            disabled={busy || !valid}
            onPress={() => {
              const current = Date.now();
              setNow(current);
              if (requested > current) onSend(requested);
            }}
          >
            {busy
              ? t("messages:openEncrypting")
              : error
                ? t("messages:retry")
                : t("messages:openSend")}
          </Action>
        </ScrollView>
      </GlassSheetContent>
    </GlassSheet>
  );
}

const styles = StyleSheet.create({
  strong: { fontWeight: "700" },
  sheet: { gap: 12, paddingTop: 4, paddingBottom: 2 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  selection: { gap: 4, padding: 12, borderRadius: 14 },
});
