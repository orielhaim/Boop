import { ScreenHeader } from "@/components/navigation/screen-header";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { namespaces } from "@/i18n";
import { Screen } from "@/components/ui/kit";
import { RelaySettings } from "@/components/ui/relay-settings";

export default function Connections() {
  const { t } = useTranslation(namespaces);
  return (
    <Screen
      navigationHeader={<ScreenHeader title={t("settings:connections")} />}
    >
      <SettingsGroup>
        <SettingsRow
          title={t("settings:mediaStorage")}
          onPress={() => router.push("/settings/connections/media-storage")}
        />
      </SettingsGroup>
      <RelaySettings />
    </Screen>
  );
}
