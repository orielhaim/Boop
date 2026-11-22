import { createContext, type ReactNode, useContext } from "react";
import { marmot, type MarmotChatList } from "@/core/marmot/native";
import { useAccountMarmotWindow } from "./marmot-window";

type ListWindow = ReturnType<
  typeof useAccountMarmotWindow<MarmotChatList, "forward" | "backward">
>;

const ChatLists = createContext<{
  inbox: ListWindow;
  archive: ListWindow;
  invitations: ListWindow;
} | null>(null);

const openInbox = () => marmot.openChatList("chats");
const openArchive = () => marmot.openChatList("archived");
const openInvitations = () =>
  marmot.openChatList("chats", { invitations: true });

export function MarmotChatLists({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const inbox = useAccountMarmotWindow(openInbox, enabled);
  const archive = useAccountMarmotWindow(openArchive, enabled);
  const invitations = useAccountMarmotWindow(openInvitations, enabled);
  return (
    <ChatLists.Provider value={{ inbox, archive, invitations }}>
      {children}
    </ChatLists.Provider>
  );
}

export function useMarmotChatLists() {
  const lists = useContext(ChatLists);
  if (!lists) throw new Error("Chat lists are unavailable");
  return lists;
}
