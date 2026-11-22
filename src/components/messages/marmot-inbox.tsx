import { ChatList, type ChatListItem } from "@kesha-antonov/react-native-chat";
import { router, Stack } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { Action, Empty, Screen } from "@/components/ui/kit";
import { toNpub } from "@/core/identity/keys";
import { marmot, type MarmotChatRow } from "@/core/marmot/native";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { space } from "@/theme";
import { useChatAppearance } from "./appearance";
import { useMarmotWindow } from "./marmot-window";

export function conversationRoute(group: string, details = false) {
  return {
    pathname: "/chat/[key]" as const,
    params: { key: `marmot-${group}`, ...(details ? { details: "1" } : {}) },
  };
}

function asChat(
  row: MarmotChatRow,
  fallback: string,
  invitationTitle: string,
): ChatListItem & { id: string } {
  return {
    id: row.id,
    title: row.invited
      ? invitationTitle
      : row.title ||
        (row.peer ? `${toNpub(row.peer).slice(0, 15)}…` : fallback),
    kind: row.kind === "group" ? "group" : "private",
    isArchived: row.archived,
    isMuted: row.muted,
    isPinned: row.pinned,
    unreadCount: row.unread,
    lastMessage:
      row.invited || row.preview == null
        ? undefined
        : {
            _id: row.id,
            text: row.preview,
            createdAt: row.updatedAt * 1_000,
            user: { _id: row.peer ?? row.id },
          },
  };
}

export function MarmotInbox({
  invitations = false,
}: {
  invitations?: boolean;
}) {
  const { t } = useTranslation(namespaces);
  const { identity } = useLocal();
  const kit = useChatAppearance();
  const [archived, setArchived] = useState(false);
  const open = useCallback(
    () => marmot.openChatList(archived ? "archived" : "chats"),
    [archived],
  );
  const { snapshot, window, error, retry } = useMarmotWindow(open);
  const fallback = t("messages:marmot.group");
  const invitationTitle = t("messages:marmot.inviteRequired");
  const chats = useMemo(
    () =>
      snapshot?.rows
        .filter((row) => row.invited === invitations)
        .map((row) => asChat(row, fallback, invitationTitle)) ?? [],
    [snapshot, invitations, fallback, invitationTitle],
  );
  const page = () => {
    if (snapshot?.hasMoreAfter)
      void window?.page("forward").catch(() => undefined);
  };

  function update(ids: { id: string }[], write: (id: string) => Promise<void>) {
    void Promise.all(ids.map(({ id }) => write(id))).catch(() =>
      Alert.alert(t("messages:updateConversationsError")),
    );
  }

  return (
    <Screen tab={!invitations} scroll={false}>
      {invitations && (
        <Stack.Screen options={{ title: t("messages:marmot.invitations") }} />
      )}
      {error ? (
        <Empty detail="" icon="chat" title={t("messages:marmot.accountError")}>
          <Action onPress={retry}>{t("common:retry")}</Action>
        </Empty>
      ) : (
        <ChatList
          {...kit}
          chats={chats}
          user={{ _id: identity.publicKey }}
          isLoading={!snapshot}
          isTopInsetApplied={false}
          isSortEnabled={false}
          isArchiveOpen={archived}
          onArchiveOpenChange={setArchived}
          onPressChat={(row) => router.push(conversationRoute(row.id))}
          onPressNewChat={
            invitations ? undefined : () => router.push("/connect")
          }
          onPinChats={(selection, pinned) =>
            update(selection, (id) => marmot.setPinned(id, pinned))
          }
          onMuteChats={(selection, muted) =>
            update(selection, (id) => marmot.setMuted(id, muted))
          }
          onArchiveChats={(selection, value) =>
            update(selection, (id) => marmot.setArchived(id, value))
          }
          listProps={{
            onEndReached: page,
            ListHeaderComponent:
              invitations || archived ? undefined : (
                <View style={styles.actions}>
                  <Action
                    size="sm"
                    onPress={() =>
                      router.push({
                        pathname: "/chat/[key]",
                        params: { key: "new-group" },
                      })
                    }
                  >
                    {t("messages:marmot.newGroup")}
                  </Action>
                  <Action size="sm" onPress={() => router.push("/requests")}>
                    {t("messages:marmot.invitations")}
                  </Action>
                </View>
              ),
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
    padding: space.sm,
  },
});
