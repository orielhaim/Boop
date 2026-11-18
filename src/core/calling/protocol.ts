import { verifyEvent } from "nostr-tools/pure";
import { z } from "zod";
import { publicKeySchema } from "../identity/keys";

export const opaqueId = z.string().regex(/^[0-9a-f]{64}$/);
export const proofKind = 20058;

const proofEvent = z.strictObject({
  id: opaqueId,
  pubkey: publicKeySchema,
  sig: z.string().regex(/^[0-9a-f]{128}$/),
  kind: z.literal(proofKind),
  created_at: z.number().int().nonnegative(),
  tags: z.tuple([]),
  content: z.string().max(4096),
});

type Peer = {
  id: string;
  key: string;
  sdp: string | undefined;
};

function fingerprints(sdp: string | undefined) {
  const values = [
    ...new Set(
      sdp
        ?.match(/^a=fingerprint:sha-256 [A-Fa-f0-9:]{95}\s*$/gm)
        ?.map((line) => line.trim().toLowerCase()) ?? [],
    ),
  ].sort();
  if (!values.length) throw new Error("Missing WebRTC fingerprint");
  return values;
}

export function peerTranscript({
  callId,
  roomId,
  challenge,
  sender,
  recipient,
}: {
  callId: string;
  roomId: string;
  challenge: string;
  sender: Peer;
  recipient: Peer;
}) {
  return JSON.stringify([
    "boop-call-proof-v2",
    callId,
    roomId,
    challenge,
    sender.id,
    recipient.id,
    sender.key,
    recipient.key,
    fingerprints(sender.sdp),
    fingerprints(recipient.sdp),
  ]);
}

export function verifyPeerProof(
  input: unknown,
  expected: string,
  signer: string,
  seconds: number,
) {
  const proof = proofEvent.safeParse(input).data;
  return (
    !!proof &&
    proof.pubkey === signer &&
    proof.content === expected &&
    Math.abs(seconds - proof.created_at) <= 30 &&
    verifyEvent(proof)
  );
}
