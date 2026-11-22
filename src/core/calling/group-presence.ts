import { z } from "zod";
import { publicKeySchema } from "../identity/keys";
import { callCapacity } from "./conference";
import { opaqueId } from "./protocol";

export const groupCallKind = 24884;
export const groupCallHeartbeat = 45_000;
const lifetime = groupCallHeartbeat * 2 + 15_000;
const presence = z.strictObject({
  version: z.literal(1),
  call: opaqueId,
  updatedAt: z.number().int().positive(),
  members: z
    .array(publicKeySchema)
    .max(callCapacity)
    .refine((members) => new Set(members).size === members.length),
});
type Presence = z.infer<typeof presence>;
type PresenceRow = {
  text: string;
  sender: string;
  sentAt: number;
  deleted: boolean;
  invalidated: boolean;
};

export function groupCallAnnouncement(
  call: string,
  members: string[],
  updatedAt = Date.now(),
) {
  return JSON.stringify({
    version: 1,
    call,
    updatedAt,
    members,
  } satisfies Presence);
}

export function discoverGroupCall(
  rows: readonly PresenceRow[],
  isMember: (key: string) => boolean,
  now = Date.now(),
) {
  const latest = new Map<string, Presence & { coordinator: string }>();
  for (const row of rows) {
    if (
      row.deleted ||
      row.invalidated ||
      row.text.length > 750 ||
      !isMember(row.sender)
    )
      continue;
    let event: Presence | undefined;
    try {
      event = presence.safeParse(JSON.parse(row.text)).data;
    } catch {
      continue;
    }
    if (
      !event ||
      event.updatedAt > now + 5_000 ||
      event.updatedAt + lifetime <= now ||
      Math.abs(event.updatedAt - row.sentAt * 1_000) > 60_000 ||
      (event.members.length > 0 &&
        (!event.members.includes(row.sender) || event.members.length < 2)) ||
      !event.members.every(isMember)
    )
      continue;
    const key = `${event.call}:${row.sender}`;
    const current = latest.get(key);
    if (
      !current ||
      current.updatedAt < event.updatedAt ||
      (current.updatedAt === event.updatedAt && !event.members.length)
    )
      latest.set(key, { ...event, coordinator: row.sender });
  }
  const active = [...latest.values()]
    .filter((event) => event.members.length > 0)
    .sort((a, b) =>
      a.call < b.call
        ? -1
        : a.call > b.call
          ? 1
          : a.updatedAt === b.updatedAt
            ? a.coordinator.localeCompare(b.coordinator)
            : b.updatedAt - a.updatedAt,
    )[0];
  return active && { ...active, expiresAt: active.updatedAt + lifetime };
}
