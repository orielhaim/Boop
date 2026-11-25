import { z } from "zod";
import { messageContent } from "./message-content";

const decimal = z.string().regex(/^\d{1,20}$/);
const deletionSource = z.enum(["author", "admin", "unknown"]);
const index = z.number().int().nonnegative();
const accepted = z.object({
  outcome: z.literal("accepted"),
  index,
  name: z.string(),
  type: z.string(),
  thumbhash: z.string().nullish(),
  plaintextHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .nullish(),
  dimensions: z.string().nullish(),
  metadata: z
    .tuple([
      z.string().max(192),
      z.string().max(192),
      z.string().max(192),
      z.string().max(192),
    ])
    .nullish(),
});
const rejected = z.object({
  outcome: z.literal("rejected"),
  index,
  reason: z.enum([
    "invalid_structure",
    "unsupported_format",
    "missing_field",
    "duplicate_field",
    "malformed_field",
  ]),
  detail: z.string().nullish(),
});

export const acceptedAttachment = accepted.transform((item) => {
  const { metadata, ...reference } = item;
  const [sizeText, durationText, levels, kind] = metadata ?? [];
  const size = sizeText && /^\d+$/.test(sizeText) ? Number(sizeText) : 0;
  const duration = durationText ? Number(durationText) : 0;
  return {
    ...reference,
    size: Number.isSafeInteger(size) && size > 0 ? size : undefined,
    duration: duration > 0 && duration <= 604800 ? duration : undefined,
    waveform: levels
      ?.split(",")
      .filter((level) => /^\d{1,2}$/.test(level))
      .map(Number)
      .filter((level) => level <= 31)
      .slice(0, 64),
    round: kind === "round" && item.type.startsWith("video/"),
    voice: kind === "voice" && item.type.startsWith("audio/"),
  };
});
export const attachments = z.array(z.union([acceptedAttachment, rejected]));

const thread = z.object({ root: z.string(), parent: z.string() });
const availability = {
  deleted: z.boolean(),
  deletionSource,
  invalidationStatus: z.string().nullish(),
};
export const message = z.object({
  id: z.string(),
  token: z.string().nullish(),
  sender: z.string(),
  text: z.string(),
  sentAt: z.number().nonnegative(),
  expiresAt: z.number().nonnegative().nullish(),
  retentionSeconds: decimal.nullish(),
  content: messageContent.nullish(),
  eventKind: z.number().int().nonnegative(),
  replyTo: z.string().nullish(),
  thread: thread.nullish(),
  replyPreview: z
    .object({
      id: z.string(),
      sender: z.string(),
      text: z.string(),
      eventKind: z.number().int().nonnegative(),
      content: messageContent.nullish(),
      mentions: z.array(z.string()),
      expiresAt: z.number().nonnegative().nullish(),
      ...availability,
    })
    .nullish(),
  mentions: z.array(z.string()),
  reactions: z.array(
    z.object({
      emoji: z.string(),
      count: z.number().nonnegative(),
      users: z.array(z.string()),
      own: z.boolean(),
    }),
  ),
  attachments,
  sourceId: z.string().nullish(),
  poll: z
    .object({
      question: z.string(),
      multiple: z.boolean(),
      open: z.boolean(),
      selected: z.array(z.string()),
      expiresAt: z.number().nullish(),
      options: z.array(
        z.object({ id: z.string(), name: z.string(), votes: z.number() }),
      ),
    })
    .nullish(),
  ...availability,
  edited: z.boolean(),
  recipientConfirmed: z.boolean(),
  historyImport: z.enum(["device", "backup"]).nullish(),
  system: z
    .object({
      type: z.string(),
      actor: z.string().nullish(),
      subject: z.string().nullish(),
      name: z.string().nullish(),
      oldName: z.string().nullish(),
      retentionSeconds: decimal.nullish(),
    })
    .nullish(),
});

type Message = z.infer<typeof message>;
export function acceptedAttachments(row: Message) {
  return row.attachments.filter((item) => item.outcome === "accepted");
}

// These are the states a timeline row actually proves. Admission errors belong
// to the originating submission and are never inferred from a missing source ID.
export function delivery(
  row: Pick<Message, "sourceId" | "recipientConfirmed" | "invalidationStatus">,
) {
  if (row.invalidationStatus) return "failed";
  if (row.recipientConfirmed) return "received";
  return row.sourceId ? "published" : "pending";
}
