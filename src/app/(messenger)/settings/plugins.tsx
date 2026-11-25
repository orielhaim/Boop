import { router } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useStore } from "zustand";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { usePluginAction } from "@/components/plugins/settings-action";
import { Ink, Screen, tapFeedback } from "@/components/ui/kit";
import {
  ListGroup,
  ListRow,
  SettingsDescription,
} from "@/components/ui/list-group";
import { useLocal } from "@/services/local-context";
import { useTheme } from "@/theme";

export default function Plugins() {
  const { t } = useTranslation("settings");
  const { torrents } = useLocal();
  const { delivery, initialized, loadFailed } = useStore(torrents.state);
  const { busy, run } = usePluginAction();
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const installed = delivery?.kind === "installed";

  useEffect(() => {
    void torrents.refresh();
  }, [torrents]);
  useEffect(() => {
    if (installed && !initialized && !loadFailed) void torrents.retryLoad();
  }, [initialized, installed, loadFailed, torrents]);

  const canOpen = installed || delivery?.kind === "pendingRemoval";
  let label: string = t("pluginInstall");
  let text: string | undefined;
  let onPress: (() => void) | undefined;

  switch (delivery?.kind) {
    case "notInstalled":
    case "failed":
      label =
        delivery.kind === "failed" ? t("pluginRetry") : t("pluginInstall");
      text = busy ? undefined : label;
      onPress = () => void run(torrents.install);
      break;
    case "installing":
      text =
        delivery.total > 0
          ? t("pluginPercent", {
              progress: Math.min(
                100,
                Math.floor((delivery.received / delivery.total) * 100),
              ),
            })
          : undefined;
      label = text ? `${t("pluginCancel")}, ${text}` : t("pluginCancel");
      onPress = () =>
        void run(() => torrents.cancelInstall(delivery.sessionId));
      break;
    case "confirmation":
      label = t("pluginConfirm");
      text = t("pluginConfirmShort");
      onPress = () =>
        void run(async () => {
          if (!(await torrents.confirmInstall(delivery.sessionId)))
            throw new Error("ConfirmationUnavailable");
        });
      break;
  }

  const status = !torrents.supported
    ? t("pluginUnsupported")
    : delivery?.kind === "failed"
      ? delivery.errorCode === -10
        ? t("pluginStorage")
        : delivery.errorCode === -6
          ? t("pluginNetwork")
          : [-2, -5, -14, -15].includes(delivery.errorCode)
            ? t("pluginPlayUnavailable")
            : t("pluginState.failed")
      : delivery?.kind === "pendingRemoval"
        ? t("pluginState.pendingRemoval")
        : undefined;

  return (
    <Screen navigationHeader={<ScreenHeader title={t("plugins")} />}>
      <ListGroup>
        <ListRow
          title={t("torrents")}
          detail={t("torrentsDescription")}
          detailLines={0}
          icon="plugins"
          onPress={
            canOpen
              ? () => router.push(torrents.descriptor.settingsRoute)
              : undefined
          }
          trailing={
            canOpen ? undefined : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ busy, disabled: busy || !onPress }}
                accessible={Boolean(onPress)}
                disabled={busy || !onPress}
                onPress={() => {
                  tapFeedback();
                  onPress?.();
                }}
                style={({ pressed }) => [
                  styles.action,
                  { width: 76 * fontScale },
                  onPress && styles.pill,
                  pressed && styles.pressed,
                ]}
              >
                {text ? (
                  <Ink kind="control" style={styles.label}>
                    {text}
                  </Ink>
                ) : torrents.supported ? (
                  <ActivityIndicator size="small" color={colors.muted} />
                ) : null}
              </Pressable>
            )
          }
        />
      </ListGroup>
      {status && <SettingsDescription>{status}</SettingsDescription>}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  action: {
    minHeight: 44,
    maxWidth: "42%",
    flexShrink: 0,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.round,
  },
  pill: { backgroundColor: theme.colors.selected },
  pressed: { backgroundColor: theme.colors.pressed },
  label: { textAlign: "center", fontVariant: ["tabular-nums"] },
}));
