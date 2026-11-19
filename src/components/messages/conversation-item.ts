import type { ChatListItem } from "@kesha-antonov/react-native-chat";
import { toNpub } from "@/core/identity/keys";
import type { ConversationSummary } from "@/db/messaging";

export type ConversationListItem = ChatListItem & {
  id: string;
  address: string;
  originalPreview?: string;
};

export function createConversationListAdapter(
  ownKey: string,
  translationLabel: (text: string) => string,
  lockedLabel?: (time: number) => string,
) {
  const items = new WeakMap<ConversationSummary, ConversationListItem>();
  return (row: ConversationSummary) => {
    const cached = items.get(row);
    if (cached) return cached;
    const next = toConversationListItem(
      row,
      ownKey,
      translationLabel,
      lockedLabel,
    );
    items.set(row, next);
    return next;
  };
}

export function toConversationListItem(
  row: ConversationSummary,
  ownKey: string,
  translationLabel?: (text: string) => string,
  lockedLabel?: (time: number) => string,
): ConversationListItem {
  const address = toNpub(row.peerKey);
  const author = row.lastMessageDirection === "outgoing" ? ownKey : row.peerKey;
  return {
    id: row.peerKey,
    address,
    originalPreview: row.translatedPreview
      ? (row.preview ?? undefined)
      : undefined,
    title: row.name ?? `${address.slice(0, 15)}…`,
    avatar: row.avatarUrl ?? undefined,
    kind: "private",
    lastMessage:
      row.lastMessageId && row.lastMessageAt !== null
        ? {
            _id: row.lastMessageId,
            text:
              row.lockedUntil != null
                ? (lockedLabel?.(row.lockedUntil) ?? "")
                : row.translatedPreview
                  ? (translationLabel?.(row.translatedPreview) ??
                    row.translatedPreview)
                  : (row.preview ?? ""),
            createdAt: row.lastMessageAt,
            user: { _id: author },
            pending: row.lastMessageStatus === "pending",
            sent: row.lastMessageStatus === "sent",
            isFailed: row.lastMessageStatus === "failed",
          }
        : undefined,
    draft: row.draft || undefined,
    unreadCount: row.unread,
    isPinned: row.pinnedRank !== null,
    isMuted: row.muted,
    isArchived: row.archived,
  };
}

export function matchesConversation(chat: ConversationListItem, query: string) {
  const needle = query.trim().toLowerCase();
  return (
    chat.title.toLowerCase().includes(needle) ||
    chat.address.includes(needle) ||
    chat.id.includes(needle) ||
    Boolean(chat.draft?.toLowerCase().includes(needle)) ||
    Boolean(chat.originalPreview?.toLowerCase().includes(needle)) ||
    Boolean(chat.lastMessage?.text.toLowerCase().includes(needle))
  );
}
