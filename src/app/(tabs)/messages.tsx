import { ChatList } from "@kesha-antonov/react-native-chat";
import { router } from "expo-router";
import { addDatabaseChangeListener } from "expo-sqlite";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { useChatAppearance } from "@/components/messages/appearance";
import {
  type ConversationListItem,
  matchesConversation,
  toConversationListItem,
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
  const { identity, chat } = useLocal();
  const { appearance, theme, darkTheme, colorScheme, labels, locale, icons } =
    useChatAppearance();
  const [archived, setArchived] = useState(false);
  const [actions, setActions] = useState(false);

  const [result, setResult] = useState<
    { chats: ConversationListItem[]; error: boolean } | undefined
  >();
  const read = useCallback(() => {
    try {
      setResult({
        chats: chat
          .conversations()
          .map((row) => toConversationListItem(row, identity.publicKey)),
        error: false,
      });
    } catch {
      setResult({ chats: [], error: true });
    }
  }, [chat, identity.publicKey]);

  useEffect(() => {
    let frame: number | undefined;
    const scheduleRead = () => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        read();
      });
    };
    const unsubscribe = chat.subscribe(scheduleRead);
    const contactChanges = addDatabaseChangeListener(({ tableName }) => {
      if (tableName === "contacts") scheduleRead();
    });
    scheduleRead();
    return () => {
      unsubscribe();
      contactChanges.remove();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [chat, read]);

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
      {result?.error ? (
        <Empty
          icon="chat"
          title={t("messages:openConversationsError")}
          detail={t("messages:readLocalError")}
        >
          <Action onPress={read}>{t("common:retry")}</Action>
        </Empty>
      ) : (
        <ChatList
          chats={result?.chats ?? []}
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
                      : labels.chatListEmpty
                }
                detail={!searching && !archived ? t("messages:startHint") : ""}
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
