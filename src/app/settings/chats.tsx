import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { Screen } from "@/components/ui/kit";
import { namespaces } from "@/i18n";

export default function ChatSettings() {
  const { t } = useTranslation(namespaces);
  return (
    <Screen>
      <SettingsGroup>
        <SettingsRow
          title={t("translation:title")}
          icon="language"
          onPress={() => router.push("/settings/chats/translation")}
        />
        <SettingsRow
          title={t("messages:storageMedia")}
          icon="storage"
          onPress={() => router.push("/settings/chats/media")}
        />
        <SettingsRow
          title={t("messages:marmot.invitations")}
          icon="chat"
          onPress={() => router.push("/requests")}
        />
        <SettingsRow
          title={t("messages:marmot.health")}
          icon="connection"
          onPress={() => router.push("./chats/health")}
        />
      </SettingsGroup>
    </Screen>
  );
}
