import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { Screen } from "@/components/ui/kit";

export default function ChatSettings() {
  const { t } = useTranslation("translation");
  return (
    <Screen>
      <SettingsGroup>
        <SettingsRow
          title={t("title")}
          icon="language"
          onPress={() => router.push("/settings/chats/translation")}
        />
      </SettingsGroup>
    </Screen>
  );
}
