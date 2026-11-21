import { z } from "zod";
import { verifiedEvent } from "../messaging/nip17";

export const profilePhotoPolicies = ["everyone", "contacts", "nobody"] as const;
export type ProfilePhotoPolicy = (typeof profilePhotoPolicies)[number];

export function photoAllowed(
  policy: ProfilePhotoPolicy,
  blocked: boolean,
  contact: boolean,
) {
  return (
    !blocked && (policy === "everyone" || (policy === "contacts" && contact))
  );
}

export function publicImageUrl(input: string) {
  if (input.length > 2048 || /[\s\\]/u.test(input)) return null;
  try {
    const url = new URL(input);
    const host = url.hostname;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u.test(
        host,
      ) ||
      /\.(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/u.test(
        host,
      )
    )
      return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function blossomHash(url: URL) {
  return /\/([a-f0-9]{64})(?:\.[a-z0-9]{1,8})?$/u.exec(url.pathname)?.[1];
}

export const maxProfileBytes = 16_384;
const profileFields = z.record(z.string(), z.unknown());

export function parseProfile(input: unknown, key: string) {
  const event = verifiedEvent(input);
  if (
    event?.kind !== 0 ||
    event.pubkey !== key ||
    event.created_at > Math.floor(Date.now() / 1000) + 60 ||
    new TextEncoder().encode(event.content).length > maxProfileBytes
  )
    return null;
  try {
    const fields = profileFields.parse(JSON.parse(event.content));
    const picture =
      typeof fields.picture === "string"
        ? publicImageUrl(fields.picture)?.href
        : undefined;
    const text = (value: unknown, max: number) =>
      typeof value === "string" && value.length <= max
        ? value.trim() || undefined
        : undefined;
    return {
      eventId: event.id,
      createdAt: event.created_at,
      fields,
      picture: picture ?? null,
      name: text(fields.display_name, 128) ?? text(fields.name, 128),
      about: text(fields.about, 2048),
    };
  } catch {
    return null;
  }
}

export type Profile = NonNullable<ReturnType<typeof parseProfile>>;

export function replaces(
  candidate: Pick<Profile, "createdAt" | "eventId">,
  previous: Pick<Profile, "createdAt" | "eventId"> | undefined,
) {
  return (
    !previous ||
    candidate.createdAt > previous.createdAt ||
    (candidate.createdAt === previous.createdAt &&
      candidate.eventId < previous.eventId)
  );
}

export function updateProfileFields(
  fields: Record<string, unknown> | undefined,
  edits: { displayName?: string; picture?: string | null },
) {
  const next = { ...fields };
  if (edits.displayName !== undefined) next.display_name = edits.displayName;
  if (edits.picture === null) delete next.picture;
  else if (edits.picture !== undefined) next.picture = edits.picture;
  return next;
}
