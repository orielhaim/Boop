import { ScreenHeader } from "@/components/navigation/screen-header";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { ListGroup, ListRow } from "@/components/ui/list-group";
import { namespaces } from "@/i18n";
import { Screen } from "@/components/ui/kit";
import { RelaySettings } from "@/components/ui/relay-settings";

export default function Connections() {
  const { t } = useTranslation(namespaces);
  return (
    <Screen
      navigationHeader={<ScreenHeader title={t("settings:connections")} />}
    >
      <ListGroup>
        <ListRow
          title={t("settings:mediaStorage")}
          onPress={() => router.push("/settings/connections/media-storage")}
        />
      </ListGroup>
      <RelaySettings />
    </Screen>
  );
}
