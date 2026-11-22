import { z } from "zod";
import { publicMediaUrl as publicImageUrl } from "../media/url";
import { verifiedEvent } from "../nostr/gift-wrap";

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

export function profileDetails(fields: Record<string, unknown> | undefined) {
  const text = (value: unknown, limit: number) =>
    typeof value === "string" && value.length <= limit
      ? value.trim() || undefined
      : undefined;
  const url = (value: unknown) =>
    typeof value === "string" && value.length <= 2048
      ? publicImageUrl(value)?.href
      : undefined;
  return {
    name: text(fields?.name, 128),
    about: text(fields?.about, 1000),
    banner: url(fields?.banner),
    website: url(fields?.website),
    nip05: text(fields?.nip05, 254),
    bot: fields?.bot === true,
  };
}

export function updateProfileFields(
  fields: Record<string, unknown> | undefined,
  edits: {
    displayName?: string;
    picture?: string | null;
    banner?: string | null;
    about?: string;
    website?: string;
    nip05?: string;
  },
) {
  const next = { ...fields };
  if (edits.displayName !== undefined) {
    next.display_name = edits.displayName;
    if (typeof fields?.name !== "string" || fields.name === fields.display_name)
      next.name = edits.displayName;
  }
  for (const key of [
    "picture",
    "banner",
    "about",
    "website",
    "nip05",
  ] as const) {
    const value = edits[key];
    if (value === null || value === "") delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next;
}

export { blossomHash, publicMediaUrl as publicImageUrl } from "../media/url";
