import { schnorr } from "@noble/curves/secp256k1.js";
import { decode, npubEncode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { z } from "zod";
import { isPublicRelayAddress, secureRelays } from "../nostr/relays";

const encodedKey = /^[0-9a-f]{64}$/;
export const publicKeySchema = z.string().refine((value) => {
  if (!encodedKey.test(value)) return false;
  try {
    schnorr.utils.lift_x(BigInt(`0x${value}`));
    return true;
  } catch {
    return false;
  }
});

export type Identity = { publicKey: string; npub: string };

export function parsePublicKey(input: string): string | null {
  return parsePublicIdentity(input)?.key ?? null;
}

export function parsePublicIdentity(
  input: string,
): { key: string; relays: string[] } | null {
  const value = input.trim().replace(/^nostr:/i, "");
  if (encodedKey.test(value.toLowerCase())) {
    const key = value.toLowerCase();
    return publicKeySchema.safeParse(key).success ? { key, relays: [] } : null;
  }
  if (value.length > 1024 || !/^(?:npub|nprofile)1/i.test(value)) return null;
  try {
    const decoded = decode(value);
    const key =
      decoded.type === "npub"
        ? decoded.data
        : decoded.type === "nprofile"
          ? decoded.data.pubkey
          : null;
    if (!key || !publicKeySchema.safeParse(key).success) return null;
    return {
      key,
      relays:
        decoded.type === "nprofile"
          ? secureRelays(decoded.data.relays ?? [])
              .filter(isPublicRelayAddress)
              .slice(0, 3)
          : [],
    };
  } catch {
    return null;
  }
}

export const toNpub = npubEncode;

export function deriveIdentity(secret: string): Identity {
  if (!encodedKey.test(secret)) throw new Error("Invalid identity storage");
  const bytes = Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(secret.slice(index * 2, index * 2 + 2), 16),
  );
  const publicKey = getPublicKey(bytes);
  return { publicKey, npub: toNpub(publicKey) };
}
