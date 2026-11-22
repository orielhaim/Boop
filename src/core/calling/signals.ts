import { z } from "zod";
import { publicKeySchema } from "../identity/keys";
import { conferenceInvite } from "./conference";
import { opaqueId } from "./protocol";

const endpoint = z.string().regex(/^[0-9A-Za-z]{20}$/);
const offerId = z.string().regex(/^[0-9A-Za-z]{20}$/);
const rtcHeader = { peerId: endpoint, offerId };
const description = z.string().min(1).max(12_000);
export const rtcOffer = z.strictObject({ ...rtcHeader, offer: description });
export type RtcOffer = z.infer<typeof rtcOffer>;
export const rtcPayload = z.union([
  rtcOffer,
  z.strictObject({ ...rtcHeader, answer: description }),
  z.strictObject({
    ...rtcHeader,
    candidates: z.array(z.string().min(1).max(1_536)).min(1).max(8),
  }),
]);
export type RtcPayload = z.infer<typeof rtcPayload>;

// Application-specific inner rumor. Only kind 1059 envelopes are published.
export const callSignalKind = 24880;
const time = z.number().int().nonnegative();
export const callGroupId = z.string().regex(/^(?:[a-f0-9]{2}){1,256}$/u);
const base = {
  version: z.literal(1),
  callId: opaqueId,
  nonce: opaqueId,
  senderKey: publicKeySchema,
  recipientKey: publicKeySchema,
  createdAt: time,
  expiresAt: time,
};

export const callSignal = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("call.invite"),
    roomId: opaqueId,
    groupId: callGroupId.optional(),
    conference: conferenceInvite.optional(),
    joinNonce: opaqueId.optional(),
    offer: rtcOffer,
  }),
  z.strictObject({
    ...base,
    type: z.literal("call.join"),
    groupId: callGroupId,
  }),
  z.strictObject({
    ...base,
    type: z.literal("call.rtc"),
    invitationId: opaqueId.optional(),
    recovery: z.literal(true).optional(),
    payload: rtcPayload,
  }),
  z.strictObject({
    ...base,
    invitationId: opaqueId.optional(),
    type: z.enum([
      "call.ringing",
      "call.accept",
      "call.reject",
      "call.cancel",
      "call.busy",
      "call.end",
    ]),
  }),
]);

export type CallSignal = z.infer<typeof callSignal>;
export type InviteSignal = Extract<CallSignal, { type: "call.invite" }>;
export type InviteDraft = Omit<InviteSignal, "offer"> & { offer?: RtcOffer };
export type RtcSignal = Extract<CallSignal, { type: "call.rtc" }>;
export type JoinSignal = Extract<CallSignal, { type: "call.join" }>;
export type CallResponse = Exclude<
  CallSignal,
  InviteSignal | RtcSignal | JoinSignal
>["type"];
export const inviteLifetime = 35_000;

export function parseCallSignal(
  content: string,
  envelope: { senderKey: string; recipientKey: string; sentAt: number },
  now: number,
) {
  if (content.length > 15_000) return null;
  try {
    const { success, data } = callSignal.safeParse(JSON.parse(content));
    if (
      !success ||
      data.senderKey !== envelope.senderKey ||
      data.recipientKey !== envelope.recipientKey ||
      data.senderKey === data.recipientKey ||
      data.createdAt !== envelope.sentAt ||
      (data.type === "call.rtc" && data.recovery && data.invitationId) ||
      (data.type === "call.invite" &&
        data.joinNonce &&
        (!data.groupId || !data.conference)) ||
      (data.type === "call.invite" &&
        data.conference &&
        (!data.conference.roster.includes(data.senderKey) ||
          data.conference.roster.includes(data.recipientKey))) ||
      data.createdAt > now + 5_000 ||
      data.expiresAt <= now ||
      data.expiresAt <= data.createdAt ||
      data.expiresAt - data.createdAt > inviteLifetime
    )
      return null;
    return data;
  } catch {
    return null;
  }
}
