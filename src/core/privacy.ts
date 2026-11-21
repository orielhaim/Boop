import type { ProfilePhotoPolicy } from "@/core/avatars/protocol";
import { and, count, eq, isNotNull } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { MessageInput, MessagingRepository } from "@/db/messaging";
import { preference, setPreference } from "@/db/queries";
import type * as schema from "@/db/schema";
import {
  blockedIdentities,
  communicationGrants,
  contacts,
  messageRequests,
  messages,
} from "@/db/schema";
import { parsePublicKey } from "./identity/keys";

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

function requestMessages(message: typeof messageRequests.$inferSelect.message) {
  return Array.isArray(message) ? message : message ? [message] : [];
}

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
      .from(blockedIdentities)
      .all()
      .map((row) => row.publicKey),
  );
  const listeners = new Set<() => void>();
  const blockListeners = new Set<(key: string) => void>();
  const calls = preference(db, "privacy.calls");
  const messagesPolicy = preference(db, "privacy.messages");
  const photos = preference(db, "privacy.profilePhotos");
  let preferences: PrivacyPreferences & { profilePhotos: ProfilePhotoPolicy } =
    {
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
  const requestRows = () =>
    db
      .select()
      .from(messageRequests)
      .where(isNotNull(messageRequests.message))
      .orderBy(messageRequests.receivedAt)
      .all();
  const pendingCount = () =>
    db
      .select({ total: count() })
      .from(messageRequests)
      .where(isNotNull(messageRequests.message))
      .get()?.total ?? 0;
  return {
    isBlocked,
    isContact,
    photoPolicy: () => preferences.profilePhotos,
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
        .from(communicationGrants)
        .where(eq(communicationGrants.publicKey, key))
        .get();
      const established =
        !grant &&
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
      db.insert(communicationGrants)
        .values({ publicKey: key, initiated: true })
        .onConflictDoUpdate({
          target: communicationGrants.publicKey,
          set: { initiated: true },
        })
        .run();
    },
    blockedKeys: () => [...blocked],
    pending: () =>
      requestRows().map(({ publicKey, message }) => ({
        publicKey,
        messages: requestMessages(message),
      })),
    pendingCount,
    request: (key: string) => requestMessages(requestRow(key)?.message ?? null),
    queue(input: MessageInput) {
      const previous = requestRow(input.peerKey);
      const messages = requestMessages(previous?.message ?? null);
      if (
        input.sentAt <= (previous?.declinedThrough ?? 0) ||
        messages.length >= maxRequestMessages ||
        messages.some(
          (message) =>
            message.id === input.id ||
            (input.eventId !== null && input.eventId === message.eventId),
        ) ||
        (messages.length === 0 && pendingCount() >= maxRequestPeers)
      )
        return;
      const message = [...messages, input].sort(
        (a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id),
      );
      if (JSON.stringify(message).length > maxRequestSize) return;
      const values = {
        receivedAt: previous?.message ? previous.receivedAt : Date.now(),
        message,
      };
      db.insert(messageRequests)
        .values({ publicKey: input.peerKey, ...values })
        .onConflictDoUpdate({ target: messageRequests.publicKey, set: values })
        .run();
      notify();
    },
    accept(key: string) {
      const inputs = requestMessages(requestRow(key)?.message ?? null);
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
        tx.insert(blockedIdentities)
          .values({ publicKey: key, blockedAt: Date.now() })
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
      db.delete(blockedIdentities)
        .where(eq(blockedIdentities.publicKey, key))
        .run();
      blocked.delete(key);
      chat.invalidate();
      notify();
    },
  };
}

export type Privacy = ReturnType<typeof createPrivacy>;
