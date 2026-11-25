import { DownloadsIndicator } from "@/components/downloads/indicator";
import { CountBadge } from "@/components/kinetik/count-badge";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { useMinimizeOnScroll } from "expo-glass-tabs";
import {
  ChatList,
  ChatListCell,
  type ChatListCellProps,
  type ChatListItem,
} from "@kesha-antonov/react-native-chat";
import { router, useIsFocused } from "expo-router";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Action, Icon, Ink, Screen } from "@/components/ui/kit";
import { QuietState } from "@/components/ui/messenger-ui";
import { useTabFabVisibility } from "@/components/navigation/tab-fab-visibility";
import { useIdentitySheet } from "@/components/people/identity-sheet";
import { usePresentedPerson } from "@/components/people/use-person";
import { toNpub } from "@/core/identity/keys";
import { isChatMuted } from "@/core/marmot/chat-mute";
import { marmot, type MarmotChatRow } from "@/core/marmot/native";
import {
  hasMention,
  quoteText,
  type Content,
} from "@/core/marmot/message-content";
import { projectMentions } from "@/core/messaging/mentions";
import { contactByKey } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useDialog } from "@/components/ui/dialog";
import { useLocal } from "@/services/local-context";
import { space } from "@/theme";
import { useChatAppearance } from "./appearance";
import { useChatClock, useMuteDuration } from "./chat-mute";
import { EmptyInbox } from "./empty-inbox";
import { useMarmotChatLists } from "./marmot-chat-lists";
import { useMarmotWindow } from "./marmot-window";
import { usePreparedGroupAvatar } from "./use-prepared-group-avatar";
import { useMentionMembers } from "./use-mention-members";

export function conversationRoute(
  group: string,
  view?: "details" | "edit" | "call" | "search" | "media",
) {
  return {
    pathname: "/chat/[key]" as const,
    params: { key: `marmot-${group}`, ...(view ? { view } : {}) },
  };
}

type ChatRow = ChatListItem & {
  id: string;
  peer?: string;
  avatarAsset?: MarmotChatRow["avatarAsset"];
  previewContent?: Content | null;
};

function asChat(
  row: MarmotChatRow,
  fallback: string,
  invitationTitle: string,
  preview: string | undefined,
  now: number,
  emptyPreview?: string,
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
    avatarAsset:
      row.kind === "group" && !row.invited && row.membership === "member"
        ? row.avatarAsset
        : undefined,
    isArchived: row.archived,
    isMuted: isChatMuted(row, now),
    isPinned: row.pinned,
    unreadCount: Math.max(row.unread, row.manualUnread ? 1 : 0),
    draft: row.invited ? undefined : (row.draft ?? undefined),
    emptyPreview,
    previewContent:
      preview === row.preview?.text ? row.preview?.content : undefined,
    lastMessage:
      row.invited || preview == null
        ? undefined
        : {
            _id: row.preview?.id ?? row.id,
            text: preview,
            createdAt: row.updatedAt * 1_000,
            user: { _id: row.preview?.sender ?? row.id },
          },
  };
}

export function MarmotInbox({
  invitations = false,
}: {
  invitations?: boolean;
}) {
  const { t } = useTranslation(namespaces);
  const dialog = useDialog();
  const chooseMuteDuration = useMuteDuration();
  const { identity, privacy, chatPreferences, conversations, db } = useLocal();
  const focused = useIsFocused();
  const setChatsFabVisible = useTabFabVisibility()?.setChatsVisible;
  const showIdentitySheet = useIdentitySheet();
  const privacyRevision = useSyncExternalStore(
    privacy.subscribe,
    privacy.revision,
  );
  const cacheRevision = useSyncExternalStore(
    conversations.subscribe,
    conversations.revision,
  );
  const kit = useChatAppearance();
  const onScroll = useMinimizeOnScroll();
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const term = useDeferredValue(search)?.trim();
  const { inbox, archive, invitations: pending } = useMarmotChatLists();
  const openSearch = useCallback(
    () =>
      marmot.openChatList(archived ? "archived" : "chats", { search: term }),
    [archived, term],
  );
  const results = useMarmotWindow(openSearch, !invitations && Boolean(term));
  const { snapshot, window, error, retry } = invitations
    ? pending
    : term
      ? results
      : archived
        ? archive
        : inbox;
  const deadlines = useMemo(
    () =>
      [...(snapshot?.rows ?? []), ...(archive.snapshot?.rows ?? [])].flatMap(
        ({ preview, mutedUntilMs }) => [
          ...(preview?.expiresAt == null ? [] : [preview.expiresAt * 1000]),
          ...(mutedUntilMs == null ? [] : [mutedUntilMs]),
        ],
      ),
    [snapshot?.rows, archive.snapshot?.rows],
  );
  const now = useChatClock(deadlines, focused);
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
          const details = await marmot.groupInvitation(group);
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
        (row.preview?.sender && privacy.isBlocked(row.preview?.sender)) ||
        (row.preview?.id &&
          chatPreferences.hidden(row.id).includes(row.preview?.id))
          ? undefined
          : row.preview?.expiresAt != null &&
              row.preview.expiresAt * 1000 <= now
            ? undefined
            : row.preview?.kind === 24881
              ? t("messages:lockedMessage")
              : row.preview?.kind === 24883
                ? t("messages:marmot.locationPreview")
                : (row.preview?.text ?? undefined);
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
            now,
          );
        }
      }
      const emptyPreview =
        !row.invited &&
        row.membership === "member" &&
        row.kind !== "unknown" &&
        row.previewSelection === "empty"
          ? t("messages:sayHello")
          : undefined;
      return asChat(row, fallback, invitationTitle, preview, now, emptyPreview);
    });
  const showEmptyInbox = Boolean(
    snapshot &&
    !snapshot.hasMoreAfter &&
    !search &&
    !term &&
    !archived &&
    !invitations &&
    chats.every((chat) => chat.isArchived),
  );
  const updateFab = useCallback(
    (visible: boolean) => {
      setChatsFabVisible?.(visible && !showEmptyInbox);
    },
    [setChatsFabVisible, showEmptyInbox],
  );
  const emptyInbox = showEmptyInbox ? (
    <EmptyInbox
      title={t("messages:inboxEmpty")}
      detail={t("messages:startHint")}
      actionLabel={kit.labels.chatListNewChat}
      focused={focused}
      onAction={() => showIdentitySheet("newConversation")}
    />
  ) : undefined;
  const page = () => {
    if (snapshot?.hasMoreAfter)
      void window?.page("forward").catch(() => undefined);
  };

  function update(task: Promise<unknown>) {
    void task.catch(() =>
      dialog.show({
        title: t("messages:updateConversationsError"),
        tone: "error",
      }),
    );
  }

  const [visibleRows, setVisibleRows] = useState(new Set<string>());
  const onViewableItemsChanged = useCallback(
    ({
      viewableItems,
    }: {
      viewableItems: { item: ChatRow; isViewable: boolean }[];
    }) => {
      const next = new Set(
        viewableItems
          .filter(({ isViewable }) => isViewable)
          .map(({ item }) => item.id),
      );
      setVisibleRows((previous) =>
        next.size === previous.size && [...next].every((id) => previous.has(id))
          ? previous
          : next,
      );
    },
    [],
  );
  const canPrepare = focused && !invitations;
  useEffect(() => {
    if (!canPrepare) return;
    conversations.setBrowsing(true);
    return () => conversations.setBrowsing(false);
  }, [canPrepare, conversations]);
  useEffect(() => {
    if (!canPrepare || !snapshot) return;
    conversations.candidates(
      snapshot.rows.filter(
        (row) =>
          !row.invited &&
          row.membership === "member" &&
          (!row.peer || !privacy.isBlocked(row.peer)),
      ),
      visibleRows,
    );
  }, [
    cacheRevision,
    canPrepare,
    conversations,
    privacy,
    privacyRevision,
    snapshot,
    visibleRows,
  ]);

  return (
    <Screen
      tab={!invitations}
      topInset={false}
      scroll={false}
      navigationHeader={
        invitations ? (
          <ScreenHeader title={t("messages:marmot.invitations")} />
        ) : undefined
      }
    >
      <ChatList<ChatRow>
        {...kit}
        labels={{
          ...kit.labels,
          actionPin: t("messages:pinChats"),
          actionUnpin: t("messages:unpinChats"),
        }}
        chats={chats}
        user={{ _id: identity.publicKey }}
        isTopInsetApplied={!invitations}
        isSortEnabled={false}
        isSearchEnabled={!invitations}
        renderHeaderRight={
          invitations || archived ? undefined : renderDownloadsIndicator
        }
        filterChat={() => true}
        onSearchChange={setSearch}
        dateFormat={kit.locale === "he" ? "D.M.YY" : undefined}
        renderChat={(props) => (
          <MarmotChatCell {...props} visible={visibleRows.has(props.chat.id)} />
        )}
        renderEmpty={(searching) =>
          !snapshot ? (
            error ? (
              <View style={styles.syncStatus}>
                <Ink kind="caption" muted accessibilityLiveRegion="polite">
                  {t("messages:marmot.accountError")}
                </Ink>
                <Action size="sm" variant="soft" onPress={retry}>
                  {t("common:retry")}
                </Action>
              </View>
            ) : (
              <ChatSyncNotice />
            )
          ) : !searching && emptyInbox ? (
            emptyInbox
          ) : (
            <View style={styles.empty}>
              <QuietState
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
          )
        }
        isArchiveOpen={archived}
        onArchiveOpenChange={setArchived}
        onPressChat={(row) => {
          conversations.noteNavigation(row.id);
          router.push(conversationRoute(row.id));
        }}
        title={
          invitations ? t("messages:marmot.invitations") : t("common:chats")
        }
        onNewChatVisibilityChange={invitations ? undefined : updateFab}
        onPinChats={
          invitations
            ? undefined
            : (selection, pinned) =>
                update(
                  marmot.setPinned(
                    selection.map(({ id }) => id),
                    pinned,
                  ),
                )
        }
        onReorderPinnedChats={
          invitations || archived || search !== null
            ? undefined
            : (order) => update(marmot.reorderPinnedChats(order))
        }
        onMuteChats={
          invitations
            ? undefined
            : (selection, muted) => {
                if (muted) chooseMuteDuration(selection.map(({ id }) => id));
                else
                  update(
                    Promise.all(
                      selection.map(({ id }) => marmot.clearChatMuted(id)),
                    ),
                  );
              }
        }
        onArchiveChats={
          invitations
            ? undefined
            : (selection, value) =>
                update(
                  Promise.all(
                    selection.map(({ id }) => marmot.setArchived(id, value)),
                  ),
                )
        }
        listProps={{
          onViewableItemsChanged,
          contentContainerStyle: invitations
            ? undefined
            : [styles.listWithFab, showEmptyInbox && styles.grow],
          // Chat Kit inserts a synthetic Archive row when only archived chats exist.
          ListFooterComponent: chats.length > 0 ? emptyInbox : undefined,
          ListFooterComponentStyle:
            emptyInbox && chats.length > 0 ? styles.grow : undefined,
          onScroll: invitations ? undefined : onScroll,
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
                    backgroundColor: pressed ? kit.colors.selected : undefined,
                  },
                ]}
              >
                <View
                  style={[
                    styles.invitationIcon,
                    { backgroundColor: kit.colors.selected },
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
                  <CountBadge count={invitationCount} tone="accent" />
                </View>
              </Pressable>
            ) : undefined,
        }}
      />
    </Screen>
  );
}

function ChatSyncNotice() {
  const { t } = useTranslation("messenger");
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 500);
    return () => clearTimeout(timer);
  }, []);
  return visible ? (
    <LoadingSkeleton layout="chats" label={t("syncingChats")} />
  ) : null;
}

function MarmotChatCell({
  visible,
  ...props
}: ChatListCellProps<ChatRow> & { visible: boolean }) {
  const { name, photo: avatar } = usePresentedPerson(
    props.chat.peer ?? "",
    props.chat.title,
    visible,
  );
  const groupAvatar = usePreparedGroupAvatar(props.chat.avatarAsset, visible);
  const { draft, lastMessage, previewContent } = props.chat;
  const mentions = /(?:nostr:|@)npub1/i;
  const { members } = useMentionMembers(
    props.chat.id,
    visible &&
      props.chat.kind === "group" &&
      (mentions.test(draft ?? "") ||
        Boolean(previewContent && hasMention(previewContent))),
  );
  const names = useMemo(
    () => new Map(members?.map((member) => [member.npub, member.label])),
    [members],
  );
  return (
    <ChatListCell
      {...props}
      renderUnreadCount={(count) => (
        <CountBadge
          count={count}
          tone={props.chat.isMuted ? "muted" : "danger"}
        />
      )}
      chat={{
        ...props.chat,
        avatar: avatar ?? groupAvatar,
        avatarIdentity: props.chat.peer ?? props.chat.id,
        title: props.chat.peer ? name : props.chat.title,
        draft: draft && projectMentions(draft, names).text,
        lastMessage: lastMessage && {
          ...lastMessage,
          text: previewContent
            ? quoteText(previewContent, lastMessage.text, names)
            : lastMessage.text,
        },
      }}
    />
  );
}

const styles = StyleSheet.create({
  listWithFab: { paddingBottom: 88 },
  grow: { flexGrow: 1 },
  empty: { padding: space.xl },
  syncStatus: {
    alignItems: "center",
    gap: space.sm,
    padding: space.lg,
  },
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
});

function renderDownloadsIndicator() {
  return <DownloadsIndicator />;
}
