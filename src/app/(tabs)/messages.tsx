import { ChatList } from "@kesha-antonov/react-native-chat";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { useChatAppearance } from "@/components/messages/appearance";
import {
  type ConversationListItem,
  createConversationListAdapter,
  matchesConversation,
} from "@/components/messages/conversation-item";
import { Action, Empty, IconButton, Screen } from "@/components/ui/kit";
import { PeerActions } from "@/components/ui/peer-actions";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";
import { space } from "@/theme";

function keys(items: ConversationListItem[]) {
  return items.map((item) => item.id);
}

export default function Messages() {
  const { t } = useTranslation(namespaces);
  const { identity, chat, conversations, messaging } = useLocal();
  const { appearance, theme, darkTheme, colorScheme, labels, locale, icons } =
    useChatAppearance();
  const [archived, setArchived] = useState(false);
  const [actions, setActions] = useState(false);

  const result = useSyncExternalStore(
    conversations.subscribe,
    conversations.getSnapshot,
    conversations.getSnapshot,
  );
  const rows = result?.rows;
  const status = useSyncExternalStore(
    messaging.subscribeStatus,
    messaging.getStatus,
    messaging.getStatus,
  );
  const sync = useSyncExternalStore(
    messaging.subscribeStatus,
    messaging.getInboxSync,
    messaging.getInboxSync,
  );
  const adapt = useMemo(
    () =>
      createConversationListAdapter(identity.publicKey, (text) =>
        t("translation:preview", { text }),
      ),
    [identity.publicKey, t],
  );
  const chats = useMemo(() => (rows ?? []).map(adapt), [rows, adapt]);
  const emptyStatus =
    sync === "syncing"
      ? t("messages:syncing")
      : sync === "failed"
        ? t("messages:syncFailed")
        : status === "online"
          ? undefined
          : t(`messages:${status}`);
  useFocusEffect(
    useCallback(() => {
      conversations.prefetch();
    }, [conversations]),
  );

  function change(write: () => void) {
    try {
      write();
    } catch {
      Alert.alert(t("messages:updateConversationsError"));
    }
  }

  return (
    <Screen tab scroll={false}>
      <PeerActions mode="chat" open={actions} onOpenChange={setActions} />
      {result?.error && chats.length === 0 ? (
        <Empty
          icon="chat"
          title={t("messages:openConversationsError")}
          detail={t("messages:readLocalError")}
        >
          <Action onPress={conversations.refresh}>{t("common:retry")}</Action>
        </Empty>
      ) : (
        <ChatList
          chats={chats}
          user={{ _id: identity.publicKey }}
          isLoading={result === undefined}
          appearance={appearance}
          theme={theme}
          darkTheme={darkTheme}
          colorScheme={colorScheme}
          locale={locale}
          dateFormat={locale === "he" ? "D.M.YY" : undefined}
          labels={labels}
          icons={icons}
          isTopInsetApplied={false}
          isSortEnabled={false}
          isArchiveOpen={archived}
          onArchiveOpenChange={setArchived}
          filterChat={matchesConversation}
          renderHeaderRight={
            archived
              ? undefined
              : () => (
                  <IconButton
                    icon="settings"
                    label={t("navigation:settings")}
                    onPress={() => router.push("/settings")}
                  />
                )
          }
          renderEmpty={(searching) => (
            <View style={styles.empty}>
              <Empty
                icon="chat"
                title={
                  searching
                    ? labels.chatListNoResults
                    : archived
                      ? t("messages:noArchived")
                      : sync === "syncing" || status === "connecting"
                        ? (emptyStatus ?? labels.chatListEmpty)
                        : labels.chatListEmpty
                }
                detail={
                  searching ||
                  archived ||
                  sync === "syncing" ||
                  status === "connecting"
                    ? ""
                    : (emptyStatus ?? t("messages:startHint"))
                }
              />
            </View>
          )}
          onPressChat={(item) =>
            router.push({ pathname: "/chat/[key]", params: { key: item.id } })
          }
          onPressNewChat={() => setActions(true)}
          onPinChats={(selection, pinned) =>
            change(() => chat.updateConversations(keys(selection), { pinned }))
          }
          onMuteChats={(selection, muted) =>
            change(() => chat.updateConversations(keys(selection), { muted }))
          }
          onArchiveChats={(selection, value) =>
            change(() =>
              chat.updateConversations(keys(selection), { archived: value }),
            )
          }
          onDeleteChats={(selection) =>
            change(() => chat.deleteConversations(keys(selection)))
          }
          onReorderPinnedChats={(ids) => change(() => chat.reorderPinned(ids))}
          listProps={{ keyboardShouldPersistTaps: "handled" }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: { padding: space.xl },
});
