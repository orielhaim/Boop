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
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Action, Empty, Icon, Ink, Screen } from "@/components/ui/kit";
import { PeerActions } from "@/components/ui/peer-actions";
import { useAvatar } from "@/core/avatars/use-avatar";
import { toNpub } from "@/core/identity/keys";
import { marmot, type MarmotChatRow } from "@/core/marmot/native";
import { projectMentions } from "@/core/messaging/mentions";
import { contactByKey } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { space } from "@/theme";
import { useChatAppearance } from "./appearance";
import { useMarmotWindow } from "./marmot-window";
import { useMarmotGroupAvatar } from "./use-marmot-group-avatar";
import { useMentionMembers } from "./use-mention-members";

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
    peer:
      !row.invited && row.kind === "direct"
        ? (row.peer ?? undefined)
        : undefined,
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
  const [actions, setActions] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const term = useDeferredValue(search);
  const open = useCallback(
    () =>
      marmot.openChatList("chats", {
        invitations,
        search: term ?? undefined,
      }),
    [invitations, term],
  );
  const archiveSearch = archived ? term : null;
  const openArchive = useCallback(
    () =>
      marmot.openChatList("archived", { search: archiveSearch ?? undefined }),
    [archiveSearch],
  );
  const openInvites = useCallback(
    () => marmot.openChatList("chats", { invitations: true }),
    [],
  );
  const pending = useMarmotWindow(openInvites, !invitations && !archived);
  const inbox = useMarmotWindow(open, !archived);
  const archive = useMarmotWindow(openArchive, !invitations);
  const { snapshot, window, error, retry } = archived ? archive : inbox;
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
  const invitationCount =
    pending.snapshot?.rows.filter(
      (row) => row.invited && invitationAllowed(row.id),
    ).length ?? 0;
  const invitationBadge = new Intl.NumberFormat(kit.locale).format(
    invitationCount,
  );
  const fallback = t("messages:marmot.group");
  const invitationTitle = t("messages:marmot.inviteRequired");
  const chats = [
    ...(snapshot?.rows ?? []),
    ...(!archived && !invitations ? (archive.snapshot?.rows ?? []) : []),
  ]
    .filter((row) =>
      row.invited
        ? invitations && invitationAllowed(row.id)
        : row.kind !== "direct" || !row.peer || !privacy.isBlocked(row.peer),
    )
    .map((row) => {
      const preview =
        (row.previewSender && privacy.isBlocked(row.previewSender)) ||
        (row.previewId &&
          chatPreferences.hidden(row.id).includes(row.previewId))
          ? undefined
          : row.previewKind === 24884 || row.previewKind === 24885
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
    });
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
      {!invitations && (
        <PeerActions mode="chat" open={actions} onOpenChange={setActions} />
      )}
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
          dateFormat={kit.locale === "he" ? "D.M.YY" : undefined}
          renderChat={(props) => <MarmotChatCell {...props} />}
          renderEmpty={(searching) => (
            <View style={styles.empty}>
              <Empty
                icon="chat"
                title={
                  searching
                    ? kit.labels.chatListNoResults
                    : invitations
                      ? t("messages:marmot.noInvitations")
                      : archived
                        ? t("messages:noArchived")
                        : kit.labels.chatListEmpty
                }
                detail={
                  searching || invitations || archived
                    ? ""
                    : t("messages:startHint")
                }
              />
            </View>
          )}
          isArchiveOpen={archived}
          onArchiveOpenChange={setArchived}
          onPressChat={(row) => router.push(conversationRoute(row.id))}
          onPressNewChat={invitations ? undefined : () => setActions(true)}
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
              !invitations &&
              !archived &&
              search === null &&
              invitationCount > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("messages:marmot.invitations")}
                  accessibilityValue={{ text: invitationBadge }}
                  onPress={() => router.push("/requests")}
                  style={({ pressed }) => [
                    styles.invitationRow,
                    {
                      direction: kit.rtl ? "rtl" : "ltr",
                      backgroundColor: pressed
                        ? kit.colors.accentSoft
                        : undefined,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.invitationIcon,
                      { backgroundColor: kit.colors.accentSoft },
                    ]}
                  >
                    <Icon
                      name="invitations"
                      size={24}
                      color={kit.colors.accent}
                    />
                  </View>
                  <View
                    style={[
                      styles.invitationContent,
                      { borderBottomColor: kit.colors.line },
                    ]}
                  >
                    <Ink
                      kind="label"
                      numberOfLines={1}
                      style={styles.invitationTitle}
                    >
                      {t("messages:marmot.invitations")}
                    </Ink>
                    <View
                      style={[
                        styles.invitationBadge,
                        { backgroundColor: kit.colors.outgoing },
                      ]}
                    >
                      <Ink
                        kind="caption"
                        style={{ color: kit.colors.outgoingInk }}
                      >
                        {invitationBadge}
                      </Ink>
                    </View>
                  </View>
                </Pressable>
              ) : undefined,
          }}
        />
      )}
    </Screen>
  );
}

function MarmotChatCell(props: ChatListCellProps<ChatRow>) {
  const avatar = useAvatar(props.chat.peer);
  const groupAvatar = useMarmotGroupAvatar(props.chat.id, props.chat.image);
  const { draft, lastMessage } = props.chat;
  const mentions = /(?:nostr:|@)npub1/i;
  const { members } = useMentionMembers(
    props.chat.id,
    props.chat.kind === "group" &&
      (mentions.test(draft ?? "") || mentions.test(lastMessage?.text ?? "")),
  );
  const names = useMemo(
    () => new Map(members?.map((member) => [member.npub, member.label])),
    [members],
  );
  return (
    <ChatListCell
      {...props}
      chat={{
        ...props.chat,
        avatar: avatar ?? groupAvatar,
        draft: draft && projectMentions(draft, names).text,
        lastMessage: lastMessage && {
          ...lastMessage,
          text: projectMentions(lastMessage.text, names).text,
        },
      }}
    />
  );
}

const styles = StyleSheet.create({
  empty: { padding: space.xl },
  invitationRow: {
    minHeight: 70,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingStart: 11,
  },
  invitationIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  invitationContent: {
    flex: 1,
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingStart: 4,
    paddingEnd: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  invitationTitle: { flex: 1, fontSize: 16, fontWeight: "500" },
  invitationBadge: {
    minWidth: 21,
    minHeight: 21,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 11,
    paddingHorizontal: 5,
  },
});
