import {
  ChatListCell,
  type ChatListCellProps,
  type ChatListItem,
} from "@kesha-antonov/react-native-chat";
import { useAvatar } from "@/core/avatars/use-avatar";

export function ProfileChatCell<T extends ChatListItem>(
  props: ChatListCellProps<T>,
) {
  const avatar = useAvatar(
    typeof props.chat.id === "string" ? props.chat.id : undefined,
    false,
  );
  return <ChatListCell {...props} chat={{ ...props.chat, avatar }} />;
}
