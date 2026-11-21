import { locationFromText, locationTag, type SharedLocation } from "./location";
import {
  fileMessageKind,
  parseFileMessage,
  type EncryptedAttachment,
} from "../media/protocol";
import type NDK from "@nostr-dev-kit/ndk";
import {
  giftWrap,
  NDKEvent,
  type NDKSigner,
  NDKUser,
} from "@nostr-dev-kit/ndk";
import { getEventHash, verifyEvent } from "nostr-tools/pure";
import { z } from "zod";
import {
  type CallSignal,
  callSignalKind,
  parseCallSignal,
} from "../calling/signals";
import { publicKeySchema } from "../identity/keys";

import {
  type MessageContent,
  maxTimeLockEnvelope,
  maxTimeLockPayload,
  parseTimeLock,
  timeLockKind,
} from "./special-messages/timelock";

export const messageKind = 14;
export const reactionKind = 7;
export const messageEditKind = 24882;
export const giftWrapKind = 1059;
export const inboxListKind = 10050;
export const callReplyRelayTag = "boop:reply-relay";
export const maxMessageLength = 4_000;
const maxEnvelopeLength = 90_000;
export const eventIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
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
const event = z.object({
  id: eventIdSchema,
  pubkey: eventIdSchema,
  kind: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  tags: z.array(z.array(z.string().max(2_048)).max(8)).max(64),
  content: z.string().max(maxEnvelopeLength),
});
const signedEvent = event.extend({ sig: z.string().regex(/^[0-9a-f]{128}$/) });
const rumorSchema = event.extend({
  kind: z.union([
    z.literal(messageKind),
    z.literal(fileMessageKind),
    z.literal(timeLockKind),
    z.literal(reactionKind),
    z.literal(messageEditKind),
    z.literal(callSignalKind),
  ]),
  sig: z.undefined().optional(),
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
  | { type: "call"; signal: CallSignal; replyRelays: string[] }
);

export function createRumor(core: RumorCore): Rumor {
  return { ...core, id: getEventHash(core) };
}

export function parseRumor(input: unknown): Rumor | null {
  const parsed = rumorSchema.safeParse(input);
  if (!parsed.success || getEventHash(parsed.data) !== parsed.data.id)
    return null;
  return parsed.data;
}

// Parse to a new object, so upstream verification caches cannot reuse another
// event's verdict for an attacker-supplied copy of an ID.
export function verifiedEvent(input: unknown) {
  const parsed = signedEvent.safeParse(input);
  return parsed.success && verifyEvent(parsed.data) ? parsed.data : null;
}

export async function wrapRumor(
  ndk: NDK,
  rumor: Rumor,
  recipient: string,
  signer: NDKSigner,
  expiresAt?: number,
) {
  return giftWrap(
    new NDKEvent(ndk, rumor),
    new NDKUser({ pubkey: recipient }),
    signer,
    expiresAt === undefined
      ? undefined
      : { wrapTags: [["expiration", String(expiresAt)]] },
  );
}

export async function unwrapPrivateEvent(
  input: unknown,
  signer: NDKSigner,
  isBlocked?: (sender: string) => boolean,
  callsOnly = false,
): Promise<PrivateEvent | null> {
  const myKey = signer.userSync.pubkey;
  const wrap = verifiedEvent(input);
  if (
    wrap?.kind !== giftWrapKind ||
    !wrap.tags.some(([tag, key]) => tag === "p" && key === myKey)
  ) {
    return null;
  }
  try {
    const payload = await signer.decrypt(
      new NDKUser({ pubkey: wrap.pubkey }),
      wrap.content,
      "nip44",
    );
    const seal = verifiedEvent(JSON.parse(payload));
    if (seal?.kind !== 13 || seal.tags.length > 0) return null;
    if (isBlocked?.(seal.pubkey)) return null;

    const plaintext = await signer.decrypt(
      new NDKUser({ pubkey: seal.pubkey }),
      seal.content,
      "nip44",
    );
    const rumor = parseRumor(JSON.parse(plaintext));
    if (!rumor || rumor.pubkey !== seal.pubkey) return null;
    if (callsOnly && rumor.kind !== callSignalKind) return null;

    if (
      rumor.kind === timeLockKind &&
      (JSON.stringify(wrap).length > maxTimeLockEnvelope ||
        plaintext.length > maxTimeLockPayload + 1_024)
    )
      return null;
    return privateEvent(rumor, myKey);
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
  if (rumor.kind === callSignalKind) {
    const signal = parseCallSignal(rumor.content, base, Date.now());
    if (!signal) return null;
    const replyRelays =
      signal.type === "call.invite" || signal.type === "call.rtc"
        ? rumor.tags
            .flatMap(([key, url]) =>
              key === callReplyRelayTag && url ? [url] : [],
            )
            .slice(0, 3)
        : [];
    return { ...base, type: "call", signal, replyRelays };
  }
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
