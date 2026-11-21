import type NDK from "@nostr-dev-kit/ndk";
import {
  giftWrap,
  NDKEvent,
  type NDKSigner,
  NDKUser,
} from "@nostr-dev-kit/ndk";
import { getEventHash, verifyEvent } from "nostr-tools/pure";
import { z } from "zod";

export const giftWrapKind = 1059;
export const inboxListKind = 10050;
export const eventIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
const event = z.object({
  id: eventIdSchema,
  pubkey: eventIdSchema,
  kind: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  tags: z.array(z.array(z.string().max(2_048)).max(8)).max(64),
  content: z.string().max(90_000),
});
const signedEvent = event.extend({ sig: z.string().regex(/^[0-9a-f]{128}$/) });
export const unsignedEvent = event.extend({ sig: z.undefined().optional() });
export type UnsignedEvent = z.infer<typeof unsignedEvent>;

export function unsignedRumor<T extends Omit<UnsignedEvent, "id" | "sig">>(
  core: T,
) {
  return { ...core, id: getEventHash(core) };
}

export function verifiedEvent(input: unknown) {
  // Verification caches must never reuse another object's verdict for this ID.
  const parsed = signedEvent.safeParse(input);
  return parsed.success && verifyEvent(parsed.data) ? parsed.data : null;
}

export function wrapRumor(
  ndk: NDK,
  rumor: UnsignedEvent,
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

export async function unwrapRumor(
  input: unknown,
  signer: NDKSigner,
  isBlocked?: (sender: string) => boolean,
) {
  const myKey = signer.userSync.pubkey;
  const wrap = verifiedEvent(input);
  if (
    wrap?.kind !== giftWrapKind ||
    !wrap.tags.some(([tag, key]) => tag === "p" && key === myKey)
  )
    return null;
  try {
    const payload = await signer.decrypt(
      new NDKUser({ pubkey: wrap.pubkey }),
      wrap.content,
      "nip44",
    );
    const seal = verifiedEvent(JSON.parse(payload));
    if (seal?.kind !== 13 || seal.tags.length > 0 || isBlocked?.(seal.pubkey))
      return null;
    const plaintext = await signer.decrypt(
      new NDKUser({ pubkey: seal.pubkey }),
      seal.content,
      "nip44",
    );
    const { success, data: rumor } = unsignedEvent.safeParse(
      JSON.parse(plaintext),
    );
    if (
      !success ||
      rumor.pubkey !== seal.pubkey ||
      getEventHash(rumor) !== rumor.id
    )
      return null;
    return { rumor, plaintextLength: plaintext.length, wrap };
  } catch {
    return null;
  }
}
