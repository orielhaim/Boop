import { z } from "zod";
import { publicKeySchema } from "../identity/keys";
import { opaqueId } from "./protocol";

export const callCapacity = 6;
export const watchedVideoLimit = 4;
export const conferenceInvite = z.strictObject({
  id: opaqueId,
  capacity: z.literal(callCapacity),
  roster: z
    .array(publicKeySchema)
    .min(2)
    .max(callCapacity - 1)
    .refine((keys) => new Set(keys).size === keys.length),
});
export type ConferenceInvite = z.infer<typeof conferenceInvite>;
export const reservationRequest = z.strictObject({
  version: z.literal(1),
  callId: opaqueId,
  invitation: conferenceInvite,
  recipient: publicKeySchema,
  expiresAt: z.number().int(),
});
export type Reservation = z.infer<typeof reservationRequest>;

export type InvitationPhase =
  | "inviting"
  | "ringing"
  | "connecting"
  | "declined"
  | "busy"
  | "unavailable"
  | "timed-out"
  | "cancelled";
export type InvitationView = {
  key: string;
  id: string;
  phase: InvitationPhase;
};
export type Participant = {
  key: string;
  muted: boolean;
  silenced: boolean;
  volume: ParticipantVolume;
  speaking: boolean;
};
export type ParticipantVolume = 25 | 50 | 100;
export type ConferenceMedia = {
  reserve(request: Reservation): Promise<boolean>;
  authorize(id: string): Promise<boolean>;
  release(id: string): void;
  silence(key: string, muted: boolean): void;
  volume(key: string, volume: ParticipantVolume): void;
};
type Seat = { request: Reservation; inviter: string; active: boolean };

export function admission({
  localKey,
  callId,
  connected,
  isBlocked = () => false,
  now = Date.now,
}: {
  localKey: string;
  callId: string;
  connected: () => readonly string[];
  isBlocked?: (key: string) => boolean;
  now?: () => number;
}) {
  let reserved: Seat | undefined;
  function current() {
    if (reserved && reserved.request.expiresAt <= now()) reserved = undefined;
    return reserved;
  }
  return {
    current,
    reserve(input: unknown, inviter: string) {
      const request = reservationRequest.safeParse(input).data;
      if (!request || request.callId !== callId) return false;
      const { expiresAt, recipient, invitation } = request;
      const roster = new Set([localKey, ...connected()]);
      if (
        isBlocked(recipient) ||
        expiresAt <= now() ||
        expiresAt > now() + 40_000 ||
        !roster.has(inviter) ||
        roster.has(recipient) ||
        roster.size !== invitation.roster.length ||
        !invitation.roster.every((key) => roster.has(key))
      )
        return false;
      const previous = current();
      if (previous)
        return (
          previous.inviter === inviter &&
          previous.request.invitation.id === invitation.id &&
          previous.request.recipient === recipient &&
          previous.request.expiresAt === expiresAt
        );
      reserved = { request, inviter, active: false };
      return true;
    },
    authorize(id: string, inviter: string) {
      const reservation = current();
      if (
        !reservation ||
        isBlocked(reservation.request.recipient) ||
        reservation.inviter !== inviter ||
        reservation.request.invitation.id !== id
      )
        return false;
      reservation.active = true;
      return true;
    },
    consume(key: string) {
      if (current()?.request.recipient === key) reserved = undefined;
    },
    permits(key: string) {
      const reservation = current();
      return (
        !!reservation?.active &&
        !isBlocked(key) &&
        reservation.request.recipient === key &&
        (reservation.inviter === localKey ||
          connected().includes(reservation.inviter))
      );
    },
    release(id: string, inviter: string) {
      if (
        current()?.request.invitation.id === id &&
        reserved?.inviter === inviter
      )
        reserved = undefined;
    },
  };
}
