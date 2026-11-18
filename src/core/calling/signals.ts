import { z } from "zod";
import { publicKeySchema } from "../identity/keys";
import { opaqueId } from "./protocol";

// Application-specific inner rumor. Only kind 1059 envelopes are published.
export const callSignalKind = 24880;
const time = z.number().int().nonnegative();
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
    roomSecret: opaqueId,
  }),
  z.strictObject({
    ...base,
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
export type CallResponse = Exclude<CallSignal, InviteSignal>["type"];
export const inviteLifetime = 35_000;

export function parseCallSignal(
  content: string,
  envelope: { senderKey: string; recipientKey: string; sentAt: number },
  now: number,
) {
  if (content.length > 1024) return null;
  try {
    const { success, data } = callSignal.safeParse(JSON.parse(content));
    if (
      !success ||
      data.senderKey !== envelope.senderKey ||
      data.recipientKey !== envelope.recipientKey ||
      data.senderKey === data.recipientKey ||
      data.createdAt !== envelope.sentAt ||
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
