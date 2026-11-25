import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { useDialog } from "@/components/ui/dialog";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { usePluginAction } from "@/components/plugins/settings-action";
import {
  ListGroup,
  ListRow,
  PreferenceToggle,
  SettingsDescription,
} from "@/components/ui/list-group";
import { SettingsMenuRow } from "@/components/settings/menu-row";
import { Screen } from "@/components/ui/kit";
import { resolutionPolicies } from "@/plugins/torrents/service";
import { formatBytes } from "@/i18n/format";
import { useLocal } from "@/services/local-context";

export default function TorrentSettings() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const { torrents } = useLocal();
  const dialog = useDialog();
  const plugin = useStore(torrents.state);
  const { busy, run } = usePluginAction();
  const [cleared, setCleared] = useState(0);
  const { delivery, loadFailed, enabled, initialized } = plugin;
  const installed = delivery?.kind === "installed";

  useEffect(() => {
    if (installed && !initialized && !loadFailed) void torrents.retryLoad();
  }, [initialized, installed, loadFailed, torrents]);

  return (
    <Screen navigationHeader={<ScreenHeader title={t("torrents")} />}>
      {installed ? (
        <ListGroup>
          {loadFailed ? (
            <ListRow
              title={t("pluginRetry")}
              detail={t("pluginLoadFailed")}
              icon="refresh"
              disabled={busy}
              onPress={() => void run(torrents.retryLoad)}
            />
          ) : (
            <PreferenceToggle
              title={t("pluginEnableTorrents")}
              value={enabled}
              disabled={!initialized || busy}
              onChange={(value) => void run(() => torrents.enable(value))}
            />
          )}
          <ListRow
            title={t("pluginUninstall")}
            icon="trash"
            disabled={busy}
            onPress={() => {
              void dialog.show({
                title: t("pluginUninstall"),
                message: t("pluginUninstallHelp"),
                tone: "danger",
                actions: [
                  { label: t("common:cancel"), tone: "cancel" },
                  {
                    label: t("pluginUninstall"),
                    tone: "danger",
                    run: torrents.uninstall,
                  },
                ],
              });
            }}
          />
        </ListGroup>
      ) : (
        <SettingsDescription>
          {delivery?.kind === "pendingRemoval"
            ? t("pluginState.pendingRemoval")
            : t("pluginState.notInstalled")}
        </SettingsDescription>
      )}
      {installed && initialized && (
        <>
          <ListGroup>
            <SettingsMenuRow
              title={t("torrentResolutionPolicy")}
              value={plugin.policy}
              options={resolutionPolicies.map((value) => ({
                value,
                label: t(`torrentPolicy.${value}`),
              }))}
              onChange={(value) => void run(async () => torrents.policy(value))}
            />
          </ListGroup>
          <SettingsDescription>{t("torrentPrivacyNotice")}</SettingsDescription>
        </>
      )}
      <ListGroup title={t("torrentStorage")}>
        <ListRow
          key={cleared}
          title={t("torrentClearCache")}
          value={formatBytes(torrents.cacheBytes(), i18n.language)}
          icon="trash"
          disabled={busy}
          onPress={() =>
            void run(async () => {
              torrents.clearCache();
              setCleared((version) => version + 1);
            })
          }
        />
      </ListGroup>
    </Screen>
  );
}
