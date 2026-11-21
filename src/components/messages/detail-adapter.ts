import type {
  IMessage,
  MessageReaction,
  ReplyMessage,
  User,
} from "@kesha-antonov/react-native-chat";
import type { MessageRecord } from "@/db/messaging";
import type { AttachmentKind } from "@/core/media/protocol";
import { locationFromText } from "@/core/messaging/location";
import { eventIdSchema } from "@/core/messaging/nip17";
import type { MediaLabel } from "./media-label";

export interface DetailMessage extends IMessage {
  _id: string;
  createdAt: number;
  direction: MessageRecord["direction"];
  unread: boolean;
  failure: string | null;
  originalText?: string;
  locked?: MessageRecord["locked"];
  timeLock?: true;
  voice?: MessageRecord["voice"];
  media?: MessageRecord["media"];
  editableRevision?: string;
  editStatus?: MessageRecord["editStatus"];
}

export type Participants = { self: User; peer: User };
type QuoteSource = Pick<
  MessageRecord,
  "id" | "direction" | "body" | "deletedAt" | "contentType"
> & { media?: MessageRecord["media"]; quotedKind?: AttachmentKind | null };

function author(row: QuoteSource, participants: Participants) {
  return row.direction === "outgoing" ? participants.self : participants.peer;
}

export function toQuote(
  row: QuoteSource,
  participants: Participants,
  lockedLabel = "",
  mediaLabel: MediaLabel = () => "",
): ReplyMessage {
  const text =
    row.contentType === "attachment"
      ? mediaLabel(row.media?.kind ?? row.quotedKind ?? "voice")
      : row.contentType === "location"
        ? mediaLabel("location")
        : row.contentType === "timelock" && !row.body
          ? lockedLabel
          : row.body;
  return { _id: row.id, text, user: author(row, participants) };
}

export function toDetailMessage(
  row: MessageRecord,
  source: QuoteSource | undefined,
  participants: Participants,
  unavailable: string,
  lockedLabel = "",
  mediaLabel: MediaLabel = () => "",
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
    text: row.contentType === "location" ? "" : row.body,
    location:
      row.contentType === "location" ? locationFromText(row.body) : undefined,
    media: row.media,
    isDownloadRequired: !!row.media,
    imagePlaceholder: row.media?.blurhash,
    locked: row.locked,
    voice: row.voice,
    isMediaUnread:
      row.direction === "incoming" &&
      !!row.media &&
      (row.media.kind === "voice" || row.media.kind === "round-video") &&
      !row.media.listened,
    timeLock: row.contentType === "timelock" ? true : undefined,
    user: author(row, participants),
    createdAt: row.sentAt,
    isEdited: row.editedAt != null,
    editedAt: row.editedAt ?? undefined,
    editableRevision:
      row.contentType === "text" &&
      row.direction === "outgoing" &&
      row.senderKey === String(participants.self._id) &&
      row.recipientKey === String(participants.peer._id) &&
      eventIdSchema.safeParse(row.eventId).success &&
      row.deletedAt === null &&
      (row.status === "sent" || row.status === "synced")
        ? (row.revisionId ?? row.eventId ?? undefined)
        : undefined,
    editStatus: row.editStatus,
    unread: row.isUnread,
    isPinned: row.isPinned,
    failure: row.failure,
    pending: row.status === "pending",
    sent: row.status === "sent",
    isFailed: row.status === "failed",
    replyMessage: row.replyTo
      ? source && source.deletedAt === null
        ? toQuote(source, participants, lockedLabel, mediaLabel)
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
    a.location?.latitude === b.location?.latitude &&
    a.location?.longitude === b.location?.longitude &&
    a.media?.kind === b.media?.kind &&
    a.media?.mime === b.media?.mime &&
    a.media?.listened === b.media?.listened &&
    a.media?.durationMs === b.media?.durationMs &&
    a.media?.dimensions?.width === b.media?.dimensions?.width &&
    a.media?.dimensions?.height === b.media?.dimensions?.height &&
    a.media?.filename === b.media?.filename &&
    a.media?.size === b.media?.size &&
    a.media?.blurhash === b.media?.blurhash &&
    a.media?.thumbhash === b.media?.thumbhash &&
    a.voice?.durationMs === b.voice?.durationMs &&
    a.voice?.listened === b.voice?.listened &&
    a.voice?.kind === b.voice?.kind &&
    a.voice?.waveform?.join(",") === b.voice?.waveform?.join(",") &&
    a.locked?.requestedAt === b.locked?.requestedAt &&
    a.locked?.roundTime === b.locked?.roundTime &&
    a.locked?.error === b.locked?.error &&
    a.user === b.user &&
    a.createdAt === b.createdAt &&
    a.editedAt === b.editedAt &&
    a.editableRevision === b.editableRevision &&
    a.editStatus === b.editStatus &&
    a.unread === b.unread &&
    a.isPinned === b.isPinned &&
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
