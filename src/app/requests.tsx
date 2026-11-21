import { useAvatarVisibility } from "@/core/avatars/use-avatar";
import { ProfileChatCell } from "@/components/messages/profile-chat-cell";
import { ChatList } from "@kesha-antonov/react-native-chat";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useChatAppearance } from "@/components/messages/appearance";
import { Empty, Screen } from "@/components/ui/kit";
import { usePrivacy } from "@/components/ui/privacy-actions";
import { nameOrAddress, useContacts } from "@/db/contacts";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";

export default function Requests() {
  const { t } = useTranslation(namespaces);
  const { identity } = useLocal();
  const privacy = usePrivacy();
  const kit = useChatAppearance();
  const contacts = new Map(
    useContacts().map((contact) => [contact.publicKey, contact]),
  );
  const chats = privacy.pending().map(({ publicKey, messages }) => {
    const contact = contacts.get(publicKey);
    const latest = messages.at(-1);
    const title = nameOrAddress(contact?.name, publicKey);
    return {
      id: publicKey,
      title,
      lastMessage: latest && {
        _id: latest.id,
        createdAt: latest.sentAt,
        user: { _id: publicKey, name: title },
        text: latest.attachment
          ? t("messages:voiceMessage")
          : latest.timeLock
            ? t("security:requestLocked")
            : latest.body,
      },
    };
  });
  const visibleAvatars = useAvatarVisibility<(typeof chats)[number]>(
    (item) => item.id,
  );
  return (
    <Screen scroll={false}>
      <ChatList
        {...kit}
        chats={chats}
        listProps={visibleAvatars}
        renderChat={(props) => <ProfileChatCell {...props} />}
        user={{ _id: identity.publicKey }}
        isHeaderVisible={false}
        isSwipeEnabled={false}
        onLongPressChat={() => {}}
        renderEmpty={() => (
          <Empty
            icon="chat"
            title={t("security:noRequests")}
            detail={t("security:requestsHelp")}
          />
        )}
        onPressChat={({ id }) =>
          router.push({ pathname: "/requests/[key]", params: { key: id } })
        }
      />
    </Screen>
  );
}
