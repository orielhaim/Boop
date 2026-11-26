import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import type { PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import Animated, { FadeIn, LinearTransition } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { Icon, Ink, type IconName } from "@/components/ui/kit";
import { marmotErrorCode } from "@/core/marmot/errors";
import type { createDeviceController } from "@/core/marmot/device-controller";
import { useTheme } from "@/theme";

export type DeviceController = ReturnType<typeof createDeviceController>;

export function countSecurityItems({
  projections,
}: ReturnType<DeviceController["getState"]>) {
  return (
    (projections.warnings?.length ?? 0) +
    (projections.signIns?.length ?? 0) +
    (projections.pairing?.prompts.filter(
      ({ state }) =>
        state.kind === "preparing" ||
        state.kind === "comparing" ||
        state.kind === "competingRequests" ||
        state.kind === "rateLimited" ||
        state.kind === "cannotLink" ||
        state.kind === "tooManyDevices",
    ).length ?? 0)
  );
}

export function formatActivity(seconds: number, language: string | undefined) {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(seconds * 1_000);
}

export function deviceError(error: unknown) {
  const code =
    error instanceof Error && error.message === "SignInChanged"
      ? error.message
      : marmotErrorCode(error);
  if (code === "PairingChanged") return "pairingChanged";
  if (code === "SignInChanged") return "signInChanged";
  if (code === "DeviceLinkPending") return "linkPending";
  if (code === "DeviceDiscoveryUnavailable") return "checkFailed";
  if (code === "DeviceRosterUnavailable") return "unreadable";
  if (code === "DeviceGroupBusy" || code === "device_group_busy")
    return "groupBusy";
  return "operationFailed";
}

const badges = {
  android: { icon: "androidDevice", colors: ["#52BC98", "#186A58"] },
  ios: { icon: "mobileDevice", colors: ["#719FF2", "#394DB5"] },
  desktop: { icon: "desktopDevice", colors: ["#A784EE", "#6244A9"] },
  unknown: { icon: "devices", colors: ["#8198C4", "#455985"] },
  warning: { icon: "warning", colors: ["#F4A853", "#AD5436"] },
  success: { icon: "check", colors: ["#49BAA9", "#187761"] },
} satisfies Record<
  string,
  { icon: IconName; colors: readonly [string, string] }
>;

export function DeviceBadge({
  platform,
  mode,
  size = 46,
}: {
  platform?: string;
  mode?: "warning" | "success";
  size?: number;
}) {
  const value = platform?.toLowerCase();
  const badge =
    badges[
      mode ??
        (value === "android"
          ? "android"
          : value === "ios"
            ? "ios"
            : value === "windows" || value === "macos" || value === "linux"
              ? "desktop"
              : "unknown")
    ];
  return (
    <LinearGradient
      colors={badge.colors}
      start={{ x: 0.1, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[
        styles.badge,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
      accessible={false}
    >
      <Icon
        name={badge.icon}
        size={Math.round(size * 0.52)}
        color="#FFFFFF"
        weight="duotone"
      />
    </LinearGradient>
  );
}

export function DeviceCard({
  children,
  center,
  hero,
}: PropsWithChildren<{
  center?: boolean;
  hero?: boolean;
}>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, center && styles.center]}>
      {hero && (
        <LinearGradient
          colors={[colors.heroStart, colors.heroEnd]}
          style={StyleSheet.absoluteFill}
        />
      )}
      {children}
    </View>
  );
}

export function DeviceHeroImage() {
  return (
    <Image
      source={require("../../../assets/devices/link.webp")}
      contentFit="contain"
      accessible={false}
      style={styles.illustration}
    />
  );
}

export function DeviceHeading({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <View style={styles.heading}>
      <Ink kind="heading" accessibilityRole="header" style={styles.centerText}>
        {title}
      </Ink>
      {detail && (
        <Ink muted style={styles.centerText}>
          {detail}
        </Ink>
      )}
    </View>
  );
}

export function DeviceChange({ children }: PropsWithChildren) {
  const { reduceMotion } = useTheme();
  return (
    <Animated.View
      entering={reduceMotion ? undefined : FadeIn.duration(160)}
      layout={reduceMotion ? undefined : LinearTransition.duration(180)}
    >
      {children}
    </Animated.View>
  );
}

export function DeviceError({ error }: { error: unknown }) {
  const { t } = useTranslation("devices");
  const { colors } = useTheme();
  if (!error) return null;
  return (
    <Ink accessibilityLiveRegion="polite" style={{ color: colors.danger }}>
      {t(deviceError(error))}
    </Ink>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.grouped,
    borderRadius: theme.radius.card,
    overflow: "hidden",
    padding: theme.space.lg,
    gap: theme.space.md,
  },
  center: { alignItems: "stretch", padding: theme.space.xl },
  badge: { alignItems: "center", justifyContent: "center", flexShrink: 0 },
  illustration: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 340,
    height: 140,
  },
  heading: { gap: theme.space.sm },
  centerText: { textAlign: "center" },
}));
