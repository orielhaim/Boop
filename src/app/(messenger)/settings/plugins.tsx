import { router } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { usePluginAction } from "@/components/plugins/settings-action";
import { Action, Screen } from "@/components/ui/kit";
import {
  ListGroup,
  ListRow,
  SettingsDescription,
} from "@/components/ui/list-group";
import { useLocal } from "@/services/local-context";

export default function Plugins() {
  const { t } = useTranslation("settings");
  const { torrents } = useLocal();
  const { delivery, initialized, loadFailed } = useStore(torrents.state);
  const { busy, run } = usePluginAction();
  const installed = delivery?.kind === "installed";

  useEffect(() => {
    void torrents.refresh();
  }, [torrents]);
  useEffect(() => {
    if (installed && !initialized && !loadFailed) void torrents.retryLoad();
  }, [initialized, installed, loadFailed, torrents]);

  const canOpen = installed || delivery?.kind === "pendingRemoval";
  const action = (() => {
    switch (delivery?.kind) {
      case "notInstalled":
        return (
          <Action
            size="sm"
            disabled={busy}
            onPress={() => void run(torrents.install)}
          >
            {t("pluginInstall")}
          </Action>
        );
      case "failed":
        return (
          <Action
            size="sm"
            disabled={busy}
            onPress={() => void run(torrents.install)}
          >
            {t("pluginRetry")}
          </Action>
        );
      case "installing":
        return (
          <Action
            size="sm"
            variant="ghost"
            disabled={busy}
            accessibilityLabel={t("pluginCancel")}
            onPress={() =>
              void run(() => torrents.cancelInstall(delivery.sessionId))
            }
          >
            {delivery.total > 0
              ? t("pluginPercent", {
                  progress: Math.min(
                    100,
                    Math.floor((delivery.received / delivery.total) * 100),
                  ),
                })
              : t("pluginCancel")}
          </Action>
        );
      case "confirmation":
        return (
          <Action
            size="sm"
            disabled={busy}
            onPress={() =>
              void run(async () => {
                if (!(await torrents.confirmInstall(delivery.sessionId)))
                  throw new Error("ConfirmationUnavailable");
              })
            }
          >
            {t("pluginConfirm")}
          </Action>
        );
    }
  })();

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
      : delivery?.kind === "installing"
        ? t("pluginState.installing")
        : delivery?.kind === "pendingRemoval"
          ? t("pluginState.pendingRemoval")
          : delivery === undefined
            ? t("pluginChecking")
            : undefined;

  return (
    <Screen navigationHeader={<ScreenHeader title={t("plugins")} />}>
      <ListGroup>
        <ListRow
          title={t("torrents")}
          detail={t("torrentsDescription")}
          detailLines={0}
          icon="plugins"
          trailing={action}
          onPress={
            canOpen
              ? () => router.push(torrents.descriptor.settingsRoute)
              : undefined
          }
        />
      </ListGroup>
      {status && <SettingsDescription>{status}</SettingsDescription>}
    </Screen>
  );
}
