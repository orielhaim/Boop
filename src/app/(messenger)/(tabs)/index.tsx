import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { MarmotInbox } from "@/components/messages/marmot-inbox";
import { QuietState } from "@/components/ui/messenger-ui";
import { Action, Screen } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { useChatsEnabled } from "@/services/local-context";

export default function Chats() {
  const { t } = useTranslation(namespaces);
  const enabled = useChatsEnabled();
  return enabled ? (
    <MarmotInbox />
  ) : (
    <Screen tab compact>
      <QuietState
        icon="chat"
        title={t("common:chats")}
        detail={t("messages:startHint")}
      >
        <Action onPress={() => router.push("/settings/privacy")}>
          {t("settings:privacy")}
        </Action>
      </QuietState>
    </Screen>
  );
}
