import { Stack, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  MarmotConversationScreen,
  OpenMarmotDirect,
} from "@/components/messages/marmot-conversation";
import {
  MarmotGroupDetailsScreen,
  NewMarmotGroup,
} from "@/components/messages/marmot-group";
import { Empty, Screen } from "@/components/ui/kit";
import { parsePublicKey } from "@/core/identity/keys";
import { namespaces } from "@/i18n";

export default function ChatRoute() {
  const { t } = useTranslation(namespaces);
  const { key, view } = useLocalSearchParams<{
    key?: string;
    view?: string;
  }>();
  if (key === "new-group") return <NewMarmotGroup />;
  if (typeof key === "string") {
    const group = /^marmot-([a-f0-9]{2,512})$/u.exec(key)?.[1];
    if (group)
      return view === "details" || view === "call" ? (
        <MarmotGroupDetailsScreen
          key={group}
          id={group}
          showCall={view === "call"}
        />
      ) : (
        <MarmotConversationScreen
          key={group}
          id={group}
          initialPanel={
            view === "search" || view === "media" ? view : undefined
          }
        />
      );
    const peer = parsePublicKey(key);
    if (peer) return <OpenMarmotDirect key={peer} peer={peer} />;
  }
  const title = t("messages:unavailable");
  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title }} />
      <Empty icon="chat" title={title} detail={t("messages:unavailableHint")} />
    </Screen>
  );
}
