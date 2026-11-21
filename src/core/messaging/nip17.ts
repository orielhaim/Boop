import { locationFromText, locationTag, type SharedLocation } from "./location";
import {
  fileMessageKind,
  parseFileMessage,
  type EncryptedAttachment,
} from "../media/protocol";
import type { NDKSigner } from "@nostr-dev-kit/ndk";
import { getEventHash } from "nostr-tools/pure";
import { z } from "zod";
import {
  eventIdSchema,
  unsignedRumor,
  unwrapRumor,
  unsignedEvent,
} from "../nostr/gift-wrap";

import { publicKeySchema } from "../identity/keys";

import {
  type MessageContent,
  maxTimeLockEnvelope,
  maxTimeLockPayload,
  parseTimeLock,
  timeLockKind,
} from "./special-messages/timelock";

export {
  eventIdSchema,
  giftWrapKind,
  inboxListKind,
  verifiedEvent,
  wrapRumor,
} from "../nostr/gift-wrap";

export const messageKind = 14;
export const reactionKind = 7;
export const messageEditKind = 24882;
export const maxMessageLength = 4_000;
const normalizedEditText = z
  .string()
  .min(1)
  .max(maxMessageLength)
  .refine((text) => text === text.trim());
export const messageEditText = z.string().trim().pipe(normalizedEditText);
const editPayload = z.strictObject({
  v: z.literal(1),
  targetId: eventIdSchema,
  previousRevisionId: eventIdSchema,
  text: normalizedEditText,
});
const maxEditPayload = 24_576;
const rumorSchema = unsignedEvent.extend({
  kind: z.union([
    z.literal(messageKind),
    z.literal(fileMessageKind),
    z.literal(timeLockKind),
    z.literal(reactionKind),
    z.literal(messageEditKind),
  ]),
});

export type Rumor = z.infer<typeof rumorSchema>;
type RumorCore = Omit<Rumor, "id" | "sig">;

export type PrivateEvent = {
  id: string;
  peerKey: string;
  senderKey: string;
  recipientKey: string;
  sentAt: number;
} & (
  | { type: "attachment"; file: EncryptedAttachment; replyTo: string | null }
  | { type: "location"; location: SharedLocation; replyTo: string | null }
  | { type: "message"; body: string; replyTo: string | null }
  | {
      type: "timelock";
      special: Extract<MessageContent, { type: "timelock" }>;
      replyTo: string | null;
    }
  | { type: "reaction"; emoji: string; targetEventId: string }
  | { type: "edit"; edit: z.infer<typeof editPayload> }
);

export function createRumor(core: RumorCore): Rumor {
  return unsignedRumor(core);
}

export function parseRumor(input: unknown): Rumor | null {
  const parsed = rumorSchema.safeParse(input);
  if (!parsed.success || getEventHash(parsed.data) !== parsed.data.id)
    return null;
  return parsed.data;
}

export async function unwrapPrivateEvent(
  input: unknown,
  signer: NDKSigner,
  isBlocked?: (sender: string) => boolean,
): Promise<PrivateEvent | null> {
  const opened = await unwrapRumor(input, signer, isBlocked);
  if (!opened) return null;
  const parsed = rumorSchema.safeParse(opened.rumor);
  if (!parsed.success) return null;
  const rumor = parsed.data;
  if (
    rumor.kind === timeLockKind &&
    (JSON.stringify(opened.wrap).length > maxTimeLockEnvelope ||
      opened.plaintextLength > maxTimeLockPayload + 1_024)
  )
    return null;
  try {
    return privateEvent(rumor, signer.userSync.pubkey);
  } catch {
    return null;
  }
}

function privateEvent(rumor: Rumor, myKey: string): PrivateEvent | null {
  if (rumor.kind === messageEditKind) return parseEditRumor(rumor, myKey);
  const participants = new Set(
    rumor.tags.filter(([key]) => key === "p").map((tag) => tag[1]),
  );
  participants.add(rumor.pubkey);
  if (participants.size !== 2 || !participants.has(myKey)) return null;

  const peerKey = [...participants].find((key) => key !== myKey);
  if (!peerKey || !publicKeySchema.safeParse(peerKey).success) return null;

  const target = rumor.tags.findLast(
    ([tag, id]) => tag === "e" && eventIdSchema.safeParse(id).success,
  )?.[1];
  const base = {
    id: rumor.id,
    peerKey,
    senderKey: rumor.pubkey,
    recipientKey: rumor.pubkey === myKey ? peerKey : myKey,
    sentAt: rumor.created_at * 1_000,
  };
  if (base.sentAt > Date.now() + 5 * 60_000) return null;
  if (rumor.kind === reactionKind) {
    const emoji = parseReaction(rumor.content);
    return target && emoji
      ? { ...base, type: "reaction", targetEventId: target, emoji }
      : null;
  }
  if (rumor.kind === timeLockKind) {
    if (rumor.content.length > maxTimeLockPayload) return null;
    const special = parseTimeLock(JSON.parse(rumor.content));
    if (!special || special.requestedAt <= base.sentAt) return null;
    return { ...base, type: "timelock", special, replyTo: target ?? null };
  }
  if (rumor.kind === fileMessageKind) {
    const file = parseFileMessage(rumor.content, rumor.tags);
    return file
      ? { ...base, type: "attachment", file, replyTo: target ?? null }
      : null;
  }
  if (
    rumor.tags.some(([tag, version]) => tag === locationTag && version === "1")
  ) {
    const location = locationFromText(rumor.content);
    if (location)
      return { ...base, type: "location", location, replyTo: target ?? null };
  }
  if (!rumor.content.trim() || rumor.content.length > 16_000) return null;
  return {
    ...base,
    type: "message",
    body: rumor.content,
    replyTo: target ?? null,
  };
}

export function parseEditRumor(
  rumor: Rumor,
  myKey: string,
): Extract<PrivateEvent, { type: "edit" }> | null {
  if (rumor.kind !== messageEditKind || rumor.content.length > maxEditPayload)
    return null;
  const [recipient, reference] = rumor.tags;
  const recipientKey = recipient?.[1];
  if (
    rumor.tags.length !== 2 ||
    recipient?.length !== 2 ||
    recipient[0] !== "p" ||
    !recipientKey ||
    !publicKeySchema.safeParse(recipientKey).success ||
    recipientKey === rumor.pubkey ||
    (myKey !== recipientKey && myKey !== rumor.pubkey) ||
    reference?.length !== 2 ||
    reference[0] !== "e"
  )
    return null;
  try {
    const raw: unknown = JSON.parse(rumor.content);
    const parsed = editPayload.safeParse(raw);
    const sentAt = rumor.created_at * 1_000;
    if (
      !parsed.success ||
      reference[1] !== parsed.data.targetId ||
      rumor.id === parsed.data.targetId ||
      rumor.id === parsed.data.previousRevisionId ||
      sentAt > Date.now() + 5 * 60_000
    )
      return null;
    return {
      type: "edit",
      edit: parsed.data,
      id: rumor.id,
      sentAt,
      senderKey: rumor.pubkey,
      recipientKey,
      peerKey: myKey === rumor.pubkey ? recipientKey : rumor.pubkey,
    };
  } catch {
    return null;
  }
}

export function parseReaction(value: string): string | null {
  if (value === "" || value === "+") return "👍";
  if (value === "-") return "👎";
  // Standard Unicode emoji only. Remote custom emoji images could track recipients.
  const emoji =
    /^(?:\p{Emoji}|\u200d|\ufe0e|\ufe0f|\u20e3|[\u{E0020}-\u{E007F}])+$/u;
  const emojiBase = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;
  return value.length <= 48 && emoji.test(value) && emojiBase.test(value)
    ? value
    : null;
}
