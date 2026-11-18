import { schnorr } from "@noble/curves/secp256k1.js";
import { decode, npubEncode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
import { z } from "zod";

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
  const value = input.trim().replace(/^nostr:/i, "");
  if (encodedKey.test(value.toLowerCase())) {
    const key = value.toLowerCase();
    return publicKeySchema.safeParse(key).success ? key : null;
  }
  if (!value.toLowerCase().startsWith("npub1") || value.length !== 63)
    return null;
  try {
    const decoded = decode(value);
    return decoded.type === "npub" &&
      publicKeySchema.safeParse(decoded.data).success
      ? decoded.data
      : null;
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

export async function loadIdentity(
  storage: {
    read: () => Promise<string | null>;
    write: (secret: string) => Promise<void>;
  },
  pinnedKey: string | null,
  random: () => Promise<Uint8Array>,
): Promise<Identity> {
  const stored = await storage.read();
  if (stored !== null) {
    const identity = deriveIdentity(stored);
    if (pinnedKey !== null && pinnedKey !== identity.publicKey)
      throw new Error("Identity mismatch");
    return identity;
  }
  if (pinnedKey !== null)
    throw new Error("Identity missing from secure storage");

  for (let attempt = 0; attempt < 4; attempt++) {
    const bytes = await random();
    if (bytes.length !== 32) throw new Error("Invalid identity entropy size");
    const secret = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    let identity: Identity;
    try {
      identity = deriveIdentity(secret);
    } catch {
      // secp256k1 rejects zero and scalars at or above the group order.
      continue;
    }
    await storage.write(secret);
    return identity;
  }
  throw new Error("Could not generate a valid secret key");
}
