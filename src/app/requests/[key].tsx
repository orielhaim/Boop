import { mediaLabels } from "@/components/messages/media-label";
import { useAvatar } from "@/core/avatars/use-avatar";
import {
  Chat,
  ChatHeader,
  MessageText,
} from "@kesha-antonov/react-native-chat";
import { router, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { useChatAppearance } from "@/components/messages/appearance";
import { Action, Empty, Ink } from "@/components/ui/kit";
import { useBlockAction, usePrivacy } from "@/components/ui/privacy-actions";
import { ScreenInsets } from "@/components/ui/screen-insets";
import { parsePublicKey } from "@/core/identity/keys";
import { nameOrAddress, useContact } from "@/db/contacts";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";
import { radius, space } from "@/theme";

function back() {
  if (router.canGoBack()) router.back();
  else router.replace("/requests");
}

export default function RequestChat() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const publicKey = parsePublicKey(key);
  return <RequestConversation publicKey={publicKey} />;
}

function RequestConversation({ publicKey }: { publicKey: string | null }) {
  const { t } = useTranslation(namespaces);
  const { identity, messaging } = useLocal();
  const privacy = usePrivacy();
  const contact = useContact(publicKey ?? "");
  const avatar = useAvatar(publicKey);
  const block = useBlockAction(publicKey ?? "", back);
  const kit = useChatAppearance(true);
  const name = publicKey
    ? nameOrAddress(contact?.name, publicKey)
    : t("security:pendingRequests");
  const strict = privacy.preferences().messages === "initiated";
  const messages = publicKey
    ? privacy.request(publicKey).map((message) => ({
        _id: message.id,
        createdAt: message.sentAt,
        user: { _id: message.senderKey, name },
        text: message.attachment
          ? t(mediaLabels[message.attachment.kind])
          : message.location
            ? t(mediaLabels.location)
            : message.timeLock
              ? t("security:requestLocked")
              : message.body,
      }))
    : [];

  function accept() {
    if (!publicKey) return;
    try {
      if (!privacy.accept(publicKey)) return;
      messaging.catchupRequest(publicKey);
      router.replace({ pathname: "/chat/[key]", params: { key: publicKey } });
    } catch {
      Alert.alert(t("security:privacyWriteFailed"));
    }
  }

  return (
    <ScreenInsets
      style={[styles.screen, { backgroundColor: kit.colors.background }]}
    >
      <ChatHeader
        {...kit}
        title={name}
        subtitle={t("security:pendingRequests")}
        avatar={publicKey ? { id: publicKey, uri: avatar } : undefined}
        onBack={back}
        isTopInsetApplied={false}
      />
      {messages.length ? (
        <>
          <View style={styles.chat}>
            <Chat
              {...kit}
              messages={messages}
              user={{ _id: identity.publicKey }}
              forceRTL={kit.rtl}
              enableKeyboardProvider={false}
              enableGestureHandlerRootView={false}
              isInverted={false}
              isAlignedTop
              isGroupChat={false}
              defaultMessageActions={false}
              reply={{ isEnabled: false }}
              renderMessageText={(props) => (
                <MessageText {...props} url={false} />
              )}
              renderInputToolbar={() => null}
            />
          </View>
          {strict ? (
            <Ink muted style={styles.notice}>
              {t("security:strictRequests")}
            </Ink>
          ) : null}
          <View style={styles.actions}>
            <Action
              variant="prominent"
              style={styles.action}
              disabled={strict}
              onPress={accept}
            >
              {t("security:acceptRequest")}
            </Action>
            <Action
              variant="ghost"
              style={[
                styles.action,
                styles.block,
                { backgroundColor: kit.colors.danger },
              ]}
              onPress={block.onPress}
            >
              <Ink
                kind="label"
                style={{
                  color: kit.colorScheme === "dark" ? "#17121C" : "#FFFFFF",
                }}
              >
                {block.label}
              </Ink>
            </Action>
          </View>
        </>
      ) : (
        <Empty icon="chat" title={t("security:noRequests")} detail="" />
      )}
    </ScreenInsets>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  chat: { flex: 1, direction: "ltr" },
  notice: { paddingHorizontal: space.lg },
  actions: { flexDirection: "row", gap: space.sm, padding: space.md },
  action: { flex: 1 },
  block: { borderRadius: radius.round },
});
