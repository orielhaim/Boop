import type { AttachmentKind } from "@/core/media/protocol";
import type { ProfilePhotoPolicy } from "@/core/avatars/protocol";
import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { MessageInput, MessagingRepository } from "@/db/messaging";
import { preference, setPreference } from "@/db/queries";
import type * as schema from "@/db/schema";
import {
  peerPermissions,
  pendingMessageEdits,
  contacts,
  messageRequests,
  messages,
} from "@/db/schema";
import { parsePublicKey } from "./identity/keys";
import {
  type LinkPreviewPolicy,
  previewPolicy,
} from "./messaging/link-previews";

export type IncomingCallPolicy = "everyone" | "contacts" | "nobody";
export type IncomingMessagePolicy = "everyone" | "contacts" | "initiated";
export type PrivacyPreferences = {
  calls: IncomingCallPolicy;
  messages: IncomingMessagePolicy;
  requests: boolean;
};

const maxRequestPeers = 64;
const maxRequestMessages = 16;
const maxRequestSize = 20_000;

export function messagePermission({
  preferences,
  blocked,
  contact,
  approved,
  initiated,
  established,
}: {
  preferences: PrivacyPreferences;
  blocked: boolean;
  contact: boolean;
  approved: boolean;
  initiated: boolean;
  established: boolean;
}): "blocked" | "allow" | "request" | "reject" {
  if (blocked) return "blocked";
  if (initiated) return "allow";
  if (preferences.messages === "initiated") return "reject";
  if (approved || contact) return "allow";
  if (
    preferences.messages === "everyone" &&
    (established || !preferences.requests)
  )
    return "allow";
  return preferences.requests ? "request" : "reject";
}

export function createPrivacy<Result>(
  db: BaseSQLiteDatabase<"sync", Result, typeof schema>,
  chat: MessagingRepository,
  localKey: string,
) {
  const blocked = new Set(
    db
      .select()
      .from(peerPermissions)
      .where(isNotNull(peerPermissions.blockedAt))
      .all()
      .map((row) => row.publicKey),
  );
  const listeners = new Set<() => void>();
  const blockListeners = new Set<(key: string) => void>();
  const calls = preference(db, "privacy.calls");
  const messagesPolicy = preference(db, "privacy.messages");
  const photos = preference(db, "privacy.profilePhotos");
  let preferences: PrivacyPreferences & {
    profilePhotos: ProfilePhotoPolicy;
    linkPreviews: LinkPreviewPolicy;
  } = {
    linkPreviews: previewPolicy(preference(db, "privacy.linkPreviews")),
    profilePhotos:
      photos === "everyone" || photos === "nobody" ? photos : "contacts",
    calls: calls === "contacts" || calls === "nobody" ? calls : "everyone",
    messages:
      messagesPolicy === "contacts" || messagesPolicy === "initiated"
        ? messagesPolicy
        : "everyone",
    requests: preference(db, "privacy.requests") === "true",
  };
  let revision = 0;
  function notify() {
    revision++;
    for (const listener of listeners) listener();
  }
  const isBlocked = (key: string) => blocked.has(key);
  const isContact = (key: string) =>
    Boolean(
      db
        .select({ key: contacts.publicKey })
        .from(contacts)
        .where(eq(contacts.publicKey, key))
        .get(),
    );
  const requestRow = (key: string) =>
    db
      .select()
      .from(messageRequests)
      .where(eq(messageRequests.publicKey, key))
      .get();
  const pendingCount = () =>
    db.select({ total: count() }).from(messageRequests).get()?.total ?? 0;
  return {
    isBlocked,
    isContact,
    photoPolicy: () => preferences.profilePhotos,
    linkPreviewPolicy: () => preferences.linkPreviews,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeBlock(listener: (key: string) => void) {
      blockListeners.add(listener);
      return () => {
        blockListeners.delete(listener);
      };
    },
    revision: () => revision,
    preferences: () =>
      preferences.messages === "initiated"
        ? { ...preferences, requests: false }
        : preferences,
    set<K extends keyof typeof preferences>(
      key: K,
      value: (typeof preferences)[K],
    ) {
      if (key === "requests" && preferences.messages === "initiated") return;
      setPreference(db, `privacy.${key}`, String(value));
      preferences = { ...preferences, [key]: value };
      notify();
    },
    canReceiveCall(key: string) {
      return (
        !isBlocked(key) &&
        (preferences.calls === "everyone" ||
          (preferences.calls === "contacts" && isContact(key)))
      );
    },
    messagePermission(key: string) {
      if (isBlocked(key)) return "blocked";
      const grant = db
        .select()
        .from(peerPermissions)
        .where(eq(peerPermissions.publicKey, key))
        .get();
      const established =
        !grant?.initiated &&
        !grant?.approved &&
        preferences.messages === "everyone" &&
        preferences.requests &&
        Boolean(
          db
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.peerKey, key),
                eq(messages.direction, "incoming"),
              ),
            )
            .get(),
        );
      return messagePermission({
        preferences,
        blocked: false,
        contact: isContact(key),
        initiated: grant?.initiated === true,
        approved: grant?.approved === true,
        established,
      });
    },
    noteCompletedCall(key: string) {
      db.insert(peerPermissions)
        .values({ publicKey: key, initiated: true })
        .onConflictDoUpdate({
          target: peerPermissions.publicKey,
          set: { initiated: true },
        })
        .run();
    },
    blockedKeys: () => [...blocked],
    pending() {
      const last = sql`json_extract(${messageRequests.messages}, '$[#-1]')`;
      return db
        .select({
          publicKey: messageRequests.publicKey,
          id: sql<string>`json_extract(${last}, '$.id')`,
          sentAt: sql<number>`json_extract(${last}, '$.sentAt')`,
          body: sql<string>`json_extract(${last}, '$.body')`,
          attachmentKind: sql<AttachmentKind | null>`json_extract(${last}, '$.attachment.kind')`,
          location: sql<number>`json_extract(${last}, '$.location') IS NOT NULL`,
          locked: sql<number>`json_extract(${last}, '$.timeLock') IS NOT NULL`,
        })
        .from(messageRequests)
        .orderBy(messageRequests.receivedAt)
        .all();
    },
    pendingCount,
    request: (key: string) => requestRow(key)?.messages ?? [],
    queue(input: MessageInput) {
      const previous = requestRow(input.peerKey);
      const messages = previous?.messages ?? [];
      if (
        messages.length >= maxRequestMessages ||
        messages.some(
          (message) =>
            message.id === input.id ||
            (input.eventId !== null && input.eventId === message.eventId),
        ) ||
        (messages.length === 0 && pendingCount() >= maxRequestPeers)
      )
        return;
      const queued = [...messages, input].sort(
        (a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id),
      );
      if (JSON.stringify(queued).length > maxRequestSize) return;
      const values = {
        receivedAt: previous?.receivedAt ?? Date.now(),
        messages: queued,
      };
      db.insert(messageRequests)
        .values({ publicKey: input.peerKey, ...values })
        .onConflictDoUpdate({ target: messageRequests.publicKey, set: values })
        .run();
      notify();
    },
    accept(key: string) {
      const inputs = requestRow(key)?.messages ?? [];
      if (
        !inputs.length ||
        isBlocked(key) ||
        preferences.messages === "initiated"
      )
        return false;
      chat.acceptRequest(key, inputs);
      notify();
      return true;
    },
    block(input: string) {
      const key = parsePublicKey(input);
      if (!key || key === localKey || isBlocked(key)) return;
      db.transaction((tx) => {
        const blockedAt = Date.now();
        tx.insert(peerPermissions)
          .values({ publicKey: key, blockedAt })
          .onConflictDoUpdate({
            target: peerPermissions.publicKey,
            set: { blockedAt },
          })
          .run();
        tx.delete(pendingMessageEdits)
          .where(eq(pendingMessageEdits.peerKey, key))
          .run();
        tx.delete(messageRequests)
          .where(eq(messageRequests.publicKey, key))
          .run();
      });
      blocked.add(key);
      for (const listener of blockListeners) listener(key);
      chat.invalidate();
      notify();
    },
    unblock(key: string) {
      db.update(peerPermissions)
        .set({ blockedAt: null })
        .where(eq(peerPermissions.publicKey, key))
        .run();
      blocked.delete(key);
      chat.invalidate();
      notify();
    },
  };
}

export type Privacy = ReturnType<typeof createPrivacy>;
