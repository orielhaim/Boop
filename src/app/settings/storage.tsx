import { NetworkStateType, useNetworkState } from "expo-network";
import { Stack, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { PieChart } from "react-native-gifted-charts";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/group";
import {
  Icon,
  IconButton,
  Ink,
  Screen,
  tapFeedback,
} from "@/components/ui/kit";
import { marmot } from "@/core/marmot/native";
import { appStorageUsage } from "@/core/storage/native";
import {
  type NativeUsage,
  type StorageCategory,
  storageBreakdown,
} from "@/core/storage/usage";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";

const palette = {
  downloads: "#5578ED",
  profileCache: "#2EBBA8",
  profileLocal: "#59A7E5",
  linkPreviews: "#E2A444",
  marmot: "#9471E6",
  database: "#E87791",
  other: "#8191A9",
} satisfies Record<StorageCategory, string>;

const connections = {
  [NetworkStateType.NONE]: "offline",
  [NetworkStateType.UNKNOWN]: "unknown",
  [NetworkStateType.CELLULAR]: "cellular",
  [NetworkStateType.WIFI]: "wifi",
  [NetworkStateType.BLUETOOTH]: "bluetooth",
  [NetworkStateType.ETHERNET]: "ethernet",
  [NetworkStateType.WIMAX]: "wimax",
  [NetworkStateType.VPN]: "vpn",
  [NetworkStateType.OTHER]: "otherConnection",
} as const;

function formatBytes(bytes: number, locale: string) {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log10(Math.max(1, bytes)) / 3),
  );
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[index],
    maximumFractionDigits: index === 0 ? 0 : 1,
  }).format(bytes / 1000 ** index);
}

type Snapshot = NativeUsage & { attachments?: number };
type Clearable = "downloads" | "profileCache" | "linkPreviews";

function Breakdown({ snapshot }: { snapshot: Snapshot }) {
  const { t, i18n } = useTranslation(namespaces);
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [selection, setSelection] = useState<StorageCategory>();
  const { categories, total } = storageBreakdown(
    snapshot.files,
    snapshot.attachments,
  );
  const entries = (Object.keys(palette) as StorageCategory[]).sort(
    (left, right) => (categories[right] ?? -1) - (categories[left] ?? -1),
  );
  const selected =
    selection && (categories[selection] ?? 0) > 0 ? selection : undefined;
  const data = entries.flatMap((key) => {
    const value = categories[key];
    if (!value) return [];
    return [
      {
        value,
        color:
          selected && selected !== key ? palette[key] + "65" : palette[key],
        onPress: () => toggle(key),
      },
    ];
  });
  const size = Math.min(80, Math.max(63, Math.floor(width * 0.22)));
  const percent = new Intl.NumberFormat(i18n.language, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const shownBytes = formatBytes(
    selected ? (categories[selected] ?? total) : total,
    i18n.language,
  );
  const shownLabel = selected ? t(`storage:${selected}`) : t("storage:used");

  function toggle(key: StorageCategory) {
    tapFeedback();
    setSelection((previous) => (previous === key ? undefined : key));
  }

  return (
    <View
      style={[
        styles.breakdown,
        { backgroundColor: colors.surface, borderColor: colors.line },
      ]}
    >
      <View style={styles.chart}>
        <View
          accessible
          accessibilityLabel={`${shownLabel}, ${shownBytes}`}
          importantForAccessibility="yes"
        >
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <PieChart
              donut
              radius={size}
              innerRadius={size - 16}
              initialAngle={-Math.PI / 2}
              backgroundColor={colors.surface}
              innerCircleColor={colors.surface}
              strokeColor={colors.surface}
              strokeWidth={data.length > 1 ? 1.75 : 0}
              data={data.length ? data : [{ value: 1, color: colors.line }]}
              centerLabelComponent={() => (
                <View style={[styles.center, { width: (size - 17) * 2 }]}>
                  <Ink
                    kind="heading"
                    style={styles.total}
                    adjustsFontSizeToFit
                    numberOfLines={1}
                  >
                    {shownBytes}
                  </Ink>
                  <Ink
                    kind="caption"
                    muted
                    style={styles.centerLabel}
                    numberOfLines={2}
                  >
                    {shownLabel}
                  </Ink>
                </View>
              )}
            />
          </View>
        </View>
        {snapshot.freeBytes !== undefined && (
          <Ink kind="caption" muted style={styles.centerLabel}>
            {t("storage:deviceFree", {
              size: formatBytes(snapshot.freeBytes, i18n.language),
            })}
          </Ink>
        )}
      </View>
      <View style={[styles.legend, { borderTopColor: colors.line }]}>
        {entries
          .filter((key) => categories[key] !== 0)
          .map((key) => {
            const value = categories[key];
            const label = t(`storage:${key}`);
            const formatted =
              value === undefined
                ? t("common:unavailable")
                : formatBytes(value, i18n.language);
            const share = value && total ? percent.format(value / total) : "";
            const active = selected === key;
            return (
              <Pressable
                key={key}
                accessibilityRole={value ? "button" : undefined}
                accessibilityState={value ? { selected: active } : undefined}
                accessibilityLabel={[label, formatted, share]
                  .filter(Boolean)
                  .join(", ")}
                onPress={value ? () => toggle(key) : undefined}
                style={({ pressed }) => [
                  styles.legendRow,
                  (active || pressed) && { backgroundColor: colors.accentSoft },
                ]}
              >
                <View
                  style={[
                    styles.dot,
                    {
                      backgroundColor:
                        value === undefined ? colors.line : palette[key],
                    },
                  ]}
                />
                <Ink kind="label" style={styles.category}>
                  {label}
                </Ink>
                <Ink kind="caption" style={styles.number}>
                  {formatted}
                </Ink>
                {!!share && (
                  <Ink kind="caption" muted style={styles.share}>
                    {share}
                  </Ink>
                )}
              </Pressable>
            );
          })}
      </View>
    </View>
  );
}

export default function StorageSettings() {
  const { t, i18n } = useTranslation(namespaces);
  const { colors } = useTheme();
  const { marmotSession, avatars, previews, lock } = useLocal();
  const chatsEnabled = useChatsEnabled();
  const network = useNetworkState();
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [clearing, setClearing] = useState<Clearable>();
  const busy = useRef(false);
  const request = useRef(0);
  const focused = useRef(false);

  const refresh = useCallback(async () => {
    const version = ++request.current;
    setPhase("loading");
    try {
      const attachments = chatsEnabled
        ? await marmotSession
            .ready()
            .then(marmot.storageUsage)
            .catch(() => undefined)
        : undefined;
      if (version !== request.current) return;
      const usage = await appStorageUsage();
      if (version !== request.current) return;
      setSnapshot({ ...usage, attachments });
      setPhase("ready");
    } catch {
      if (version === request.current) setPhase("error");
    }
  }, [chatsEnabled, marmotSession]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void refresh();
      return () => {
        focused.current = false;
        request.current += 1;
      };
    }, [refresh]),
  );

  const mayClear = () =>
    focused.current &&
    AppState.currentState === "active" &&
    !lock.getState().locked;

  function confirmClear(key: Clearable) {
    Alert.alert(t(`storage:clear_${key}`), t(`storage:clearDetail_${key}`), [
      { text: t("common:cancel"), style: "cancel" },
      {
        text: t("storage:clear"),
        style: "destructive",
        onPress: () => {
          if (busy.current || !mayClear()) return;
          busy.current = true;
          setClearing(key);
          void (async () => {
            try {
              if (key === "downloads") {
                await marmotSession.ready();
                if (!mayClear()) return;
                await marmot.clearDownloads();
              } else if (key === "profileCache") {
                avatars.clear();
              } else {
                previews.clear();
              }
            } catch {
              if (mayClear()) Alert.alert(t("storage:clearError"));
            } finally {
              busy.current = false;
              setClearing(undefined);
              if (focused.current) void refresh();
            }
          })();
        },
      },
    ]);
  }

  const disabled = phase === "loading" || clearing !== undefined;
  const connection =
    network.isConnected === false && network.type !== NetworkStateType.UNKNOWN
      ? "offline"
      : connections[network.type ?? NetworkStateType.UNKNOWN];
  const details = snapshot?.traffic;
  const clearable: Clearable[] = chatsEnabled
    ? ["downloads", "profileCache", "linkPreviews"]
    : ["profileCache", "linkPreviews"];

  return (
    <Screen compact>
      <Stack.Screen
        options={{
          headerRight: () =>
            phase === "loading" ? (
              <ActivityIndicator
                size="small"
                color={colors.accent}
                style={styles.headerProgress}
              />
            ) : (
              <IconButton
                icon="refresh"
                label={t("storage:refresh")}
                disabled={disabled}
                onPress={() => void refresh()}
              />
            ),
        }}
      />
      {snapshot ? (
        <Breakdown snapshot={snapshot} />
      ) : phase === "loading" ? (
        <View
          style={styles.loading}
          accessible
          accessibilityLabel={t("storage:measuring")}
        >
          <ActivityIndicator color={colors.accent} />
          <Ink kind="caption" muted>
            {t("storage:measuring")}
          </Ink>
        </View>
      ) : (
        <SettingsDescription>
          {t("storage:measurementError")}
        </SettingsDescription>
      )}
      {snapshot?.partial && (
        <SettingsDescription>{t("storage:partial")}</SettingsDescription>
      )}
      {snapshot && phase === "error" && (
        <SettingsDescription>
          {t("storage:measurementError")}
        </SettingsDescription>
      )}
      {snapshot && (
        <>
          <SettingsGroup title={t("storage:manage")}>
            {clearable.map((key) => (
              <SettingsRow
                key={key}
                title={t(`storage:clear_${key}`)}
                disabled={disabled}
                value={clearing === key ? t("storage:clearing") : undefined}
                trailing={<Icon name="erase" size={18} color={colors.muted} />}
                onPress={() => confirmClear(key)}
              />
            ))}
          </SettingsGroup>
          <SettingsDescription>{t("storage:cacheDetail")}</SettingsDescription>
        </>
      )}
      <SettingsGroup title={t("storage:network")}>
        <SettingsRow
          title={t("storage:connection")}
          value={t(`storage:${connection}`)}
        />
        {details && (
          <View style={styles.traffic}>
            {(["received", "sent"] as const).map((direction) => {
              const label = t(`storage:${direction}`);
              const bytes = formatBytes(details[direction], i18n.language);
              return (
                <View
                  key={direction}
                  accessible
                  accessibilityLabel={`${label}, ${bytes}`}
                  style={styles.metric}
                >
                  <View style={styles.metricLabel}>
                    <Icon
                      name={direction === "received" ? "download" : "send"}
                      size={15}
                    />
                    <Ink kind="caption" muted style={styles.category}>
                      {label}
                    </Ink>
                  </View>
                  <Ink kind="heading" style={styles.metricValue}>
                    {bytes}
                  </Ink>
                </View>
              );
            })}
          </View>
        )}
      </SettingsGroup>
      {snapshot && (
        <SettingsDescription>
          {t(details ? "storage:sinceBoot" : "storage:trafficUnavailable")}
        </SettingsDescription>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  breakdown: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    overflow: "hidden",
  },
  chart: { paddingTop: 14, paddingBottom: 12, alignItems: "center", gap: 7 },
  center: { alignItems: "center", gap: 2 },
  centerLabel: { textAlign: "center" },
  total: { fontSize: 24, fontVariant: ["tabular-nums"], textAlign: "center" },
  legend: { borderTopWidth: StyleSheet.hairlineWidth, padding: space.sm },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    gap: space.sm,
    borderRadius: 10,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  category: { flex: 1, flexShrink: 1 },
  number: { fontVariant: ["tabular-nums"], textAlign: "right" },
  share: { fontVariant: ["tabular-nums"], minWidth: 45, textAlign: "right" },
  traffic: {
    flexDirection: "row",
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.md,
  },
  metric: { flex: 1, gap: space.xs },
  metricLabel: { flexDirection: "row", alignItems: "center", gap: space.xs },
  metricValue: { fontVariant: ["tabular-nums"] },
  headerProgress: { marginHorizontal: space.lg },
  loading: {
    minHeight: 190,
    justifyContent: "center",
    alignItems: "center",
    gap: space.sm,
  },
});
