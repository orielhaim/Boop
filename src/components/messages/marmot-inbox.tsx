import {
  ChatList,
  ChatListCell,
  type ChatListCellProps,
  type ChatListItem,
} from "@kesha-antonov/react-native-chat";
import { router, Stack } from "expo-router";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { Action, Empty, Ink, Screen } from "@/components/ui/kit";
import { useAvatar } from "@/core/avatars/use-avatar";
import { toNpub } from "@/core/identity/keys";
import { marmot, type MarmotChatRow } from "@/core/marmot/native";
import { contactByKey } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { space } from "@/theme";
import { useChatAppearance } from "./appearance";
import { useMarmotWindow } from "./marmot-window";
import { useMarmotGroupAvatar } from "./use-marmot-group-avatar";

export function conversationRoute(
  group: string,
  view?: "details" | "call" | "search" | "media",
) {
  return {
    pathname: "/chat/[key]" as const,
    params: { key: `marmot-${group}`, ...(view ? { view } : {}) },
  };
}

type ChatRow = ChatListItem & { id: string; peer?: string; image?: string };

function asChat(
  row: MarmotChatRow,
  fallback: string,
  invitationTitle: string,
  preview: string | undefined,
): ChatRow {
  return {
    id: row.id,
    title: row.invited
      ? invitationTitle
      : row.title ||
        (row.peer ? `${toNpub(row.peer).slice(0, 15)}…` : fallback),
    kind: row.kind === "group" ? "group" : "private",
    peer: row.invited ? undefined : (row.peer ?? undefined),
    image:
      row.invited || row.membership !== "member"
        ? undefined
        : (row.image ?? undefined),
    isArchived: row.archived,
    isMuted: row.muted,
    isPinned: row.pinned,
    unreadCount: Math.max(row.unread, row.manualUnread ? 1 : 0),
    draft: row.invited ? undefined : (row.draft ?? undefined),
    lastMessage:
      row.invited || preview == null
        ? undefined
        : {
            _id: row.previewId ?? row.id,
            text: preview,
            createdAt: row.updatedAt * 1_000,
            user: { _id: row.previewSender ?? row.id },
          },
  };
}

export function MarmotInbox({
  invitations = false,
}: {
  invitations?: boolean;
}) {
  const { t } = useTranslation(namespaces);
  const { identity, privacy, chatPreferences, db } = useLocal();
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const kit = useChatAppearance();
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const term = useDeferredValue(search);
  const open = useCallback(
    () =>
      marmot.openChatList(archived ? "archived" : "chats", {
        invitations,
        search: term ?? undefined,
      }),
    [archived, invitations, term],
  );
  const openInvites = useCallback(
    () => marmot.openChatList("chats", { invitations: true }),
    [],
  );
  const pending = useMarmotWindow(openInvites, !invitations && !archived);
  const { snapshot, window, error, retry } = useMarmotWindow(open);
  const [inviters, setInviters] = useState<Record<string, string>>();
  const pendingIds = (invitations ? snapshot : pending.snapshot)?.rows
    .map((row) => row.id)
    .join(",");
  useEffect(() => {
    if (!pendingIds) return;
    let live = true;
    async function readInviters() {
      const entries = await Promise.allSettled(
        (pendingIds ?? "").split(",").map(async (group) => {
          const details = await marmot.groupDetails(group);
          return [group, details.inviter ?? ""] as const;
        }),
      );
      if (live)
        setInviters(
          Object.fromEntries(
            entries.flatMap((entry) =>
              entry.status === "fulfilled" ? [entry.value] : [],
            ),
          ),
        );
    }
    void readInviters();
    return () => {
      live = false;
    };
  }, [pendingIds]);
  function invitationAllowed(id: string) {
    const inviter = inviters?.[id];
    if (!inviter) return false;
    const permission = privacy.messagePermission(inviter);
    return permission === "allow" || permission === "request";
  }
  const hasInvitations = Boolean(
    pending.snapshot?.rows.some((row) => invitationAllowed(row.id)),
  );
  const fallback = t("messages:marmot.group");
  const invitationTitle = t("messages:marmot.inviteRequired");
  const chats =
    snapshot?.rows
      .filter((row) =>
        row.invited
          ? invitationAllowed(row.id)
          : !row.peer || !privacy.isBlocked(row.peer),
      )
      .map((row) => {
        const preview =
          (row.previewSender && privacy.isBlocked(row.previewSender)) ||
          (row.previewId &&
            chatPreferences.hidden(row.id).includes(row.previewId))
            ? undefined
            : row.previewKind === 24881
              ? t("messages:lockedMessage")
              : row.previewKind === 24883
                ? t("messages:marmot.locationPreview")
                : (row.preview ?? undefined);
        if (row.invited) {
          const inviter = inviters?.[row.id];
          if (inviter) {
            const name =
              contactByKey(db, inviter).get()?.name ??
              toNpub(inviter).slice(0, 16) + "…";
            return asChat(
              row,
              fallback,
              row.title || t("messages:marmot.invitedBy", { name }),
              undefined,
            );
          }
        }
        return asChat(row, fallback, invitationTitle, preview);
      }) ?? [];
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
        <ChatList<ChatRow>
          {...kit}
          chats={chats}
          user={{ _id: identity.publicKey }}
          isLoading={!snapshot}
          isTopInsetApplied={false}
          isSortEnabled={false}
          isSearchEnabled={!invitations}
          filterChat={() => true}
          onSearchChange={setSearch}
          renderChat={(props) => <MarmotChatCell {...props} />}
          renderEmpty={
            invitations
              ? () => (
                  <Ink style={styles.empty}>
                    {t("messages:marmot.noInvitations")}
                  </Ink>
                )
              : undefined
          }
          isArchiveOpen={archived}
          onArchiveOpenChange={setArchived}
          onPressChat={(row) => router.push(conversationRoute(row.id))}
          onPressNewChat={
            invitations ? undefined : () => router.push("/connect")
          }
          onPinChats={
            invitations
              ? undefined
              : (selection, pinned) =>
                  update(selection, (id) => marmot.setPinned(id, pinned))
          }
          onMuteChats={
            invitations
              ? undefined
              : (selection, muted) =>
                  update(selection, (id) => marmot.setMuted(id, muted))
          }
          onArchiveChats={
            invitations
              ? undefined
              : (selection, value) =>
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
                    {hasInvitations ? " •" : ""}
                  </Action>
                </View>
              ),
          }}
        />
      )}
    </Screen>
  );
}

function MarmotChatCell(props: ChatListCellProps<ChatRow>) {
  const avatar = useAvatar(props.chat.peer);
  const groupAvatar = useMarmotGroupAvatar(props.chat.id, props.chat.image);
  return (
    <ChatListCell
      {...props}
      chat={{ ...props.chat, avatar: avatar ?? groupAvatar }}
    />
  );
}

const styles = StyleSheet.create({
  empty: { textAlign: "center", padding: space.md },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
    padding: space.sm,
  },
});
