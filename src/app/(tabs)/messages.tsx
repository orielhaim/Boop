import { type ChatIcons, ChatList } from "@kesha-antonov/react-native-chat";
import { router } from "expo-router";
import { addDatabaseChangeListener } from "expo-sqlite";
import { useCallback, useEffect, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { useChatAppearance } from "@/components/messages/appearance";
import {
  type ConversationListItem,
  matchesConversation,
  toConversationListItem,
} from "@/components/messages/conversation-item";
import { Action, Empty, Icon, IconButton, Screen } from "@/components/ui/kit";
import { PeerActions } from "@/components/ui/peer-actions";
import { useLocal } from "@/services/local";
import { space } from "@/theme";

function keys(items: ConversationListItem[]) {
  return items.map((item) => item.id);
}

const messageIcons: ChatIcons = {
  pencil: ({ color, size }) => <Icon name="add" color={color} size={size} />,
};

export default function Messages() {
  const { identity, chat } = useLocal();
  const { appearance, theme, darkTheme, colorScheme, labels, locale } =
    useChatAppearance();
  const [archived, setArchived] = useState(false);
  const [actions, setActions] = useState(false);
  const he = locale === "he";

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
      Alert.alert(
        he ? "לא ניתן לעדכן שיחות" : "Could not update conversations",
      );
    }
  }

  return (
    <Screen tab scroll={false}>
      <PeerActions
        mode="chat"
        hebrew={he}
        open={actions}
        onOpenChange={setActions}
      />
      {result?.error ? (
        <Empty
          icon="chat"
          title={
            he ? "לא ניתן לפתוח את השיחות" : "Could not open conversations"
          }
          detail={
            he
              ? "אירעה שגיאה בקריאת הנתונים המקומיים."
              : "Boop could not read local chat data."
          }
        >
          <Action onPress={read}>{he ? "ניסיון חוזר" : "Try again"}</Action>
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
          labels={labels}
          icons={messageIcons}
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
                    label={he ? "הגדרות" : "Settings"}
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
                    ? (labels.chatListNoResults ?? "")
                    : archived
                      ? he
                        ? "אין שיחות בארכיון"
                        : "No archived conversations"
                      : (labels.chatListEmpty ?? "No conversations yet")
                }
                detail={
                  !searching && !archived
                    ? he
                      ? "הזינו כתובת או סרקו קוד QR כדי להתחיל שיחה."
                      : "Enter an address or scan a QR code to start a chat."
                    : ""
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
