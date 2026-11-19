import { Stack, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { DetailConversation } from "@/components/messages/detail";
import { Empty, Screen } from "@/components/ui/kit";
import { parsePublicKey } from "@/core/identity/keys";
import { namespaces } from "@/i18n";

export default function ChatRoute() {
  const { t } = useTranslation(namespaces);
  const params = useLocalSearchParams<{ key: string }>();
  const peerKey =
    typeof params.key === "string" ? parsePublicKey(params.key) : null;
  if (!peerKey) {
    const title = t("messages:unavailable");
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: true, title }} />
        <Empty
          icon="chat"
          title={title}
          detail={t("messages:unavailableHint")}
        />
      </Screen>
    );
  }
  return <DetailConversation key={peerKey} peerKey={peerKey} />;
}
