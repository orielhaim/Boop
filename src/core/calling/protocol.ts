import { verifyEvent } from "nostr-tools/pure";
import { z } from "zod";
import { publicKeySchema } from "../identity/keys";

export const opaqueId = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.number().int().nonnegative();
export const callInvitation = z.strictObject({
  callId: opaqueId,
  roomSecret: opaqueId,
  caller: publicKeySchema,
  recipient: publicKeySchema,
  expiresAt: timestamp,
});

export type CallInvitation = z.infer<typeof callInvitation>;

/** One gate per active identity. The caller first verifies the NIP-17 envelope. */
export class IncomingInvitations {
  #seen = new Map<string, number>();

  accept(
    input: unknown,
    verifiedSender: string,
    recipient: string,
    now: number,
  ) {
    const invitation = validateInvitation(
      input,
      verifiedSender,
      recipient,
      now,
    );
    if (!invitation) return null;
    for (const [id, expiresAt] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(id);
    }
    const id = `${invitation.caller}:${invitation.callId}`;
    if (this.#seen.has(id) || this.#seen.size >= 256) return null;
    this.#seen.set(id, invitation.expiresAt);
    return invitation;
  }
}

function validateInvitation(
  input: unknown,
  verifiedSender: string,
  recipient: string,
  now: number,
) {
  const decoded = callInvitation.safeParse(input);
  if (!decoded.success) return null;
  const invitation = decoded.data;
  if (
    invitation.caller !== verifiedSender ||
    invitation.recipient !== recipient ||
    invitation.caller === recipient ||
    invitation.expiresAt <= now ||
    invitation.expiresAt - now > 60_000
  )
    return null;
  return invitation;
}

const proofEvent = z.strictObject({
  id: opaqueId,
  pubkey: publicKeySchema,
  sig: z.string().regex(/^[0-9a-f]{128}$/),
  kind: z.literal(20058),
  created_at: timestamp,
  tags: z.tuple([]),
  content: z.string().max(1024),
});

export type PeerChallenge = {
  callId: string;
  challenge: string;
  remotePeerId: string;
  localPeerId: string;
  expectedKey: string;
  localKey: string;
};

export function verifyPeerProof(
  input: unknown,
  session: PeerChallenge,
  nowSeconds: number,
) {
  const decoded = proofEvent.safeParse(input);
  if (!decoded.success) return false;
  const proof = decoded.data;
  return (
    proof.pubkey === session.expectedKey &&
    Math.abs(nowSeconds - proof.created_at) <= 60 &&
    proof.content ===
      JSON.stringify([
        "boop-call-proof-v1",
        session.callId,
        session.challenge,
        session.remotePeerId,
        session.localPeerId,
        session.expectedKey,
        session.localKey,
      ]) &&
    verifyEvent(proof)
  );
}

export interface CallSignaling {
  invite(invitation: CallInvitation): Promise<void>;
  respond(
    callId: string,
    peerKey: string,
    response: "accepted" | "rejected" | "cancelled",
  ): Promise<void>;
}
