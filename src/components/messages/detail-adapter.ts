import type {
  IMessage,
  MessageReaction,
  ReplyMessage,
  User,
} from "@kesha-antonov/react-native-chat";
import type { MessageRecord } from "@/db/messaging";

export interface DetailMessage extends IMessage {
  _id: string;
  createdAt: number;
  direction: MessageRecord["direction"];
  unread: boolean;
  failure: string | null;
  originalText?: string;
  locked?: MessageRecord["locked"];
  timeLock?: true;
}

export type Participants = { self: User; peer: User };
type QuoteSource = Pick<
  MessageRecord,
  "id" | "direction" | "body" | "deletedAt" | "contentType"
>;

function author(row: QuoteSource, participants: Participants) {
  return row.direction === "outgoing" ? participants.self : participants.peer;
}

export function toQuote(
  row: QuoteSource,
  participants: Participants,
  lockedLabel = "",
): ReplyMessage {
  const text =
    row.contentType === "timelock" && !row.body ? lockedLabel : row.body;
  return { _id: row.id, text, user: author(row, participants) };
}

export function toDetailMessage(
  row: MessageRecord,
  source: QuoteSource | undefined,
  participants: Participants,
  unavailable: string,
  lockedLabel = "",
): DetailMessage {
  const groups = new Map<string, string[]>();
  for (const reaction of row.reactions) {
    const authors = groups.get(reaction.emoji) ?? [];
    if (!authors.includes(reaction.author)) authors.push(reaction.author);
    groups.set(reaction.emoji, authors);
  }

  const reactions: MessageReaction[] = [...groups.entries()]
    .sort(([emojiA], [emojiB]) =>
      emojiA < emojiB ? -1 : Number(emojiA > emojiB),
    )
    .map(([emoji, userIds]) => ({ emoji, userIds: userIds.sort() }));

  return {
    _id: row.id,
    direction: row.direction,
    text: row.body,
    locked: row.locked,
    timeLock: row.contentType === "timelock" ? true : undefined,
    user: author(row, participants),
    createdAt: row.sentAt,
    unread: row.isUnread,
    failure: row.failure,
    pending: row.status === "pending",
    sent: row.status === "sent",
    isFailed: row.status === "failed",
    replyMessage: row.replyTo
      ? source && source.deletedAt === null
        ? toQuote(source, participants, lockedLabel)
        : { _id: row.replyTo, text: unavailable, user: { _id: "" } }
      : undefined,
    reactions: reactions.length ? reactions : undefined,
    linkPreview: null,
  };
}

export function equalDetailMessage(a: DetailMessage, b: DetailMessage) {
  return (
    a._id === b._id &&
    a.direction === b.direction &&
    a.text === b.text &&
    a.timeLock === b.timeLock &&
    a.locked?.requestedAt === b.locked?.requestedAt &&
    a.locked?.roundTime === b.locked?.roundTime &&
    a.locked?.error === b.locked?.error &&
    a.user === b.user &&
    a.createdAt === b.createdAt &&
    a.unread === b.unread &&
    a.failure === b.failure &&
    a.pending === b.pending &&
    a.sent === b.sent &&
    a.isFailed === b.isFailed &&
    a.replyMessage?._id === b.replyMessage?._id &&
    a.replyMessage?.text === b.replyMessage?.text &&
    a.replyMessage?.user._id === b.replyMessage?.user._id &&
    a.replyMessage?.user.name === b.replyMessage?.user.name &&
    (a.reactions?.length ?? 0) === (b.reactions?.length ?? 0) &&
    (!a.reactions ||
      a.reactions.every((reaction, index) => {
        const next = b.reactions?.[index];
        return (
          reaction.emoji === next?.emoji &&
          reaction.userIds.length === next.userIds.length &&
          reaction.userIds.every((id, idx) => id === next.userIds[idx])
        );
      }))
  );
}
