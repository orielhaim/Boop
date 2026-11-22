import { Redirect } from "expo-router";
import { MarmotInbox } from "@/components/messages/marmot-inbox";
import { useChatsEnabled } from "@/services/local-context";

export default function Messages() {
  return useChatsEnabled() ? <MarmotInbox /> : <Redirect href="/" />;
}
