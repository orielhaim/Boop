import { router, usePathname } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { Icon, IconButton, Ink, tapFeedback } from "@/components/ui/kit";
import { useLocal } from "@/services/local-context";
import { useTheme } from "@/theme";
import { countSecurityItems } from "./presentation";

export function DeviceSecurityBanner() {
  const { deviceController } = useLocal();
  const { t } = useTranslation(["devices", "common"]);
  const { colors } = useTheme();
  const path = usePathname();
  const insets = useSafeAreaInsets();
  const state = useSyncExternalStore(
    deviceController.subscribe,
    deviceController.getState,
  );
  const count = countSecurityItems(state);
  const urgent = Boolean(state.projections.warnings?.length);
  const alertKeys = [
    ...(state.projections.warnings?.map(
      (row) => `${row.slotIdHex}/${row.occurredAt}`,
    ) ?? []),
    ...(state.projections.signIns
      ?.filter((row) => row.state.kind === "prompt")
      .map((row) => row.slotIdHex) ?? []),
    ...(state.projections.pairing?.prompts
      .filter(
        ({ state: prompt }) =>
          prompt.kind === "preparing" || prompt.kind === "comparing",
      )
      .map((prompt) => prompt.promptId) ?? []),
  ]
    .sort()
    .join("|");
  const [dismissed, dismiss] = useState("");
  // Settings remains the entry point for dismissed and deferred items.
  if (
    !alertKeys ||
    alertKeys === dismissed ||
    path.startsWith("/settings/devices") ||
    path.startsWith("/settings/identity-keys") ||
    path.startsWith("/lock")
  )
    return null;
  return (
    <View style={[styles.banner, { top: insets.top + 6 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t("devices:security")}. ${t("devices:attentionCount", { count })}`}
        style={styles.open}
        onPress={() => {
          tapFeedback();
          router.push({
            pathname: "/settings/devices",
            params: { view: "security" },
          });
        }}
      >
        <Icon
          name={urgent ? "warning" : "lock"}
          color={urgent ? colors.warning : colors.accent}
          size={23}
        />
        <View style={styles.labels}>
          <Ink kind="rowTitle">
            {t(urgent ? "devices:warning" : "devices:security")}
          </Ink>
          <Ink kind="description" muted>
            {t("devices:attentionCount", { count })}
          </Ink>
        </View>
      </Pressable>
      <IconButton
        icon="close"
        label={t("common:close")}
        tone="plain"
        onPress={() => dismiss(alertKeys)}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    position: "absolute",
    zIndex: 50,
    alignSelf: "center",
    width: "92%",
    maxWidth: 470,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.raised,
    borderWidth: 1,
    borderColor: theme.colors.line,
    borderRadius: theme.radius.group,
    paddingHorizontal: theme.space.sm,
    boxShadow: theme.glass.shadow,
    elevation: 8,
  },
  open: {
    flex: 1,
    flexDirection: "row",
    gap: theme.space.md,
    alignItems: "center",
    paddingHorizontal: theme.space.sm,
    paddingVertical: theme.space.md,
    minHeight: 52,
  },
  labels: { flex: 1 },
}));
