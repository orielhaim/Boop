import { Stack, useLocalSearchParams } from "expo-router";
import { useChatAppearance } from "@/components/messages/appearance";
import { DetailConversation } from "@/components/messages/detail";
import { Empty, Screen } from "@/components/ui/kit";
import { parsePublicKey } from "@/core/identity/keys";

export default function ChatRoute() {
  const params = useLocalSearchParams<{ key: string }>();
  const { locale } = useChatAppearance();
  const hebrew = /^he(?:-|$)/i.test(locale);
  const peerKey =
    typeof params.key === "string" ? parsePublicKey(params.key) : null;
  if (!peerKey) {
    const title = hebrew ? "השיחה אינה זמינה" : "Conversation unavailable";
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: true, title }} />
        <Empty
          icon="chat"
          title={title}
          detail={
            hebrew
              ? "אפשר לפתוח שיחה מתוך הודעות או אנשי קשר."
              : "Open a conversation from Messages or Contacts."
          }
        />
      </Screen>
    );
  }
  return <DetailConversation key={peerKey} peerKey={peerKey} />;
}
