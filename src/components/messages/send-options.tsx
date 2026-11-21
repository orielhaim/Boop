import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, { FadeInUp } from "react-native-reanimated";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetDescription,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import { Action, Icon, Ink } from "@/components/ui/kit";
import {
  maxTimeLockDate,
  scheduleUnlock,
} from "@/core/messaging/special-messages/timelock";
import { resolveLanguage } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { useTheme } from "@/theme";

export type SendMenuAnchor = {
  x: number;
  y: number;
  width: number;
  available: number;
};

export function SpecialSendMenu({
  anchor,
  rtl,
  reducedMotion,
  onClose,
  onOpenLater,
}: {
  anchor: SendMenuAnchor;
  rtl: boolean;
  reducedMotion: boolean;
  onClose: () => void;
  onOpenLater: () => void;
}) {
  const { t } = useTranslation("messages");
  const { colors } = useTheme();
  const menuItem = useRef<ComponentRef<typeof Pressable>>(null);
  useEffect(() => {
    if (menuItem.current)
      AccessibilityInfo.sendAccessibilityEvent(menuItem.current, "focus");
  }, []);
  const width = Math.min(248, anchor.available - 16);
  const x = rtl ? anchor.x : anchor.x + anchor.width - width;
  const options = [
    {
      key: "openLater",
      label: t("openLater"),
      hint: t("openLaterHint"),
      icon: "history",
      onPress: onOpenLater,
    },
  ] satisfies {
    key: string;
    label: string;
    hint: string;
    icon: React.ComponentProps<typeof Icon>["name"];
    onPress: () => void;
  }[];
  return (
    <View
      style={styles.layer}
      pointerEvents="box-none"
      onAccessibilityEscape={onClose}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        accessible={false}
        onPress={onClose}
      />
      <Animated.View
        entering={reducedMotion ? undefined : FadeInUp.duration(160)}
        style={[
          styles.menu,
          {
            width,
            left: Math.max(8, Math.min(x, anchor.available - width - 8)),
            bottom: anchor.y + 8,
          },
        ]}
      >
        <GlassSurface
          preset="overlay"
          elevation="raised"
          style={styles.menuSurface}
        >
          {options.map(({ key, label, hint, icon, onPress }, index) => (
            <Pressable
              key={key}
              ref={index === 0 ? menuItem : undefined}
              accessibilityRole="menuitem"
              accessibilityLabel={label}
              accessibilityHint={hint}
              onAccessibilityEscape={onClose}
              onPress={onPress}
              style={({ pressed }) => [
                styles.menuItem,
                rtl && styles.rowRtl,
                pressed && { backgroundColor: colors.accentSoft },
              ]}
            >
              <View
                style={[
                  styles.menuIcon,
                  { backgroundColor: colors.accentSoft },
                ]}
              >
                <Icon name={icon} size={21} color={colors.accent} />
              </View>
              <View style={styles.menuText}>
                <Ink style={styles.strong}>{label}</Ink>
                <Ink kind="caption" muted>
                  {hint}
                </Ink>
              </View>
            </Pressable>
          ))}
        </GlassSurface>
      </Animated.View>
    </View>
  );
}

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
            style={[styles.selection, { backgroundColor: colors.accentSoft }]}
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
  layer: { ...StyleSheet.absoluteFill, zIndex: 5 },
  menu: { position: "absolute" },
  menuSurface: { borderRadius: 20 },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 10,
    borderRadius: 20,
  },
  rowRtl: { flexDirection: "row-reverse" },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  menuText: { flex: 1, gap: 2 },
  strong: { fontWeight: "700" },
  sheet: { gap: 12, paddingTop: 4, paddingBottom: 2 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  selection: { gap: 4, padding: 12, borderRadius: 14 },
});
