import { z } from "zod";
import { publicKeySchema } from "../identity/keys";
import { callCapacity } from "./conference";
import { opaqueId } from "./protocol";

export const groupCallKind = 24884;
export const groupCallLease = 30 * 60_000;
export const groupCallRenewAfter = 25 * 60_000;
const presence = z.strictObject({
  version: z.literal(2),
  call: opaqueId,
  updatedAt: z.number().int().positive(),
  ended: z.boolean(),
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
  invalidated: boolean;
};

export function groupCallAnnouncement(
  call: string,
  members: string[],
  updatedAt = Date.now(),
  ended = false,
) {
  return JSON.stringify({
    version: 2,
    call,
    updatedAt,
    ended,
    members,
  } satisfies Presence);
}

export function discoverGroupCall(
  rows: readonly PresenceRow[],
  isMember: (key: string) => boolean,
  now = Date.now(),
) {
  const latest = new Map<string, Presence & { coordinator: string }>();
  const announced = new Set<string>();
  for (const row of rows) {
    if (row.invalidated || row.text.length > 750 || !isMember(row.sender))
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
      event.updatedAt + groupCallLease <= now ||
      Math.abs(event.updatedAt - row.sentAt * 1_000) > 60_000 ||
      (event.ended && event.members.length > 0) ||
      (event.members.length > 0 && !event.members.includes(row.sender))
    )
      continue;
    const key = `${event.call}:${row.sender}`;
    if (event.members.length) announced.add(key);
    const current = latest.get(key);
    if (
      !current ||
      current.updatedAt < event.updatedAt ||
      (current.updatedAt === event.updatedAt && !event.members.length)
    )
      latest.set(key, { ...event, coordinator: row.sender });
  }
  const ended = new Map<string, number>();
  for (const [key, event] of latest) {
    if (event.ended && announced.has(key))
      ended.set(
        event.call,
        Math.max(ended.get(event.call) ?? 0, event.updatedAt),
      );
  }
  const currentSessions = [...latest.values()]
    .filter(
      (event) =>
        event.members.length > 0 &&
        event.updatedAt > (ended.get(event.call) ?? 0),
    )
    .sort((a, b) =>
      a.call < b.call
        ? -1
        : a.call > b.call
          ? 1
          : a.updatedAt === b.updatedAt
            ? a.coordinator.localeCompare(b.coordinator)
            : b.updatedAt - a.updatedAt,
    );
  const active = currentSessions[0];
  if (!active) return undefined;
  const members = active.members.filter(isMember);
  const routes = [
    ...new Set([
      active.coordinator,
      ...members,
      ...currentSessions
        .filter((event) => event.call === active.call)
        .map((event) => event.coordinator),
    ]),
  ].slice(0, callCapacity);
  return {
    ...active,
    members,
    routes,
    expiresAt: active.updatedAt + groupCallLease,
  };
}
