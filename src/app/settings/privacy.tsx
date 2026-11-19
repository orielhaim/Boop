import { router } from "expo-router";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { Screen } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";

export default function Privacy() {
  const { t } = useTranslation(namespaces);
  const { lock } = useLocal();
  const { enabled } = useSyncExternalStore(lock.subscribe, lock.getState);
  return (
    <Screen>
      <SettingsGroup title={t("security:deviceAccess")}>
        <SettingsRow
          title={t("security:appLock")}
          value={enabled ? t("common:on") : t("common:off")}
          icon="lock"
          onPress={() => router.push("/settings/privacy/app-lock")}
        />
        <SettingsRow
          title={t("security:permissions")}
          icon="settings"
          onPress={() => router.push("/settings/privacy/permissions")}
        />
      </SettingsGroup>
      <SettingsGroup title={t("security:callPrivacy")}>
        <SettingsRow
          title={t("security:incomingVideo")}
          icon="camera"
          onPress={() => router.push("/settings/privacy/incoming-video")}
        />
      </SettingsGroup>
    </Screen>
  );
}
