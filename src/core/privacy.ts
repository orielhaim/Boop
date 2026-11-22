import type { ProfilePhotoPolicy } from "@/core/avatars/protocol";
import { eq, isNotNull } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { preference, setPreference } from "@/db/queries";
import type * as schema from "@/db/schema";
import { contacts, peerPermissions } from "@/db/schema";
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
  function noteInitiation(key: string) {
    db.insert(peerPermissions)
      .values({ publicKey: key, initiated: true })
      .onConflictDoUpdate({
        target: peerPermissions.publicKey,
        set: { initiated: true },
      })
      .run();
  }

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
      return messagePermission({
        preferences,
        blocked: false,
        contact: isContact(key),
        initiated: grant?.initiated === true,
        approved: grant?.approved === true,
        established: false,
      });
    },
    noteCompletedCall: noteInitiation,
    noteInitiatedMessage: noteInitiation,
    approveInvitation(key: string) {
      if (isBlocked(key)) return;
      db.insert(peerPermissions)
        .values({ publicKey: key, approved: true })
        .onConflictDoUpdate({
          target: peerPermissions.publicKey,
          set: { approved: true },
        })
        .run();
    },
    blockedKeys: () => [...blocked],
    block(input: string) {
      const key = parsePublicKey(input);
      if (!key || key === localKey || isBlocked(key)) return;
      const blockedAt = Date.now();
      db.insert(peerPermissions)
        .values({ publicKey: key, blockedAt })
        .onConflictDoUpdate({
          target: peerPermissions.publicKey,
          set: { blockedAt },
        })
        .run();
      blocked.add(key);
      for (const listener of blockListeners) listener(key);
      notify();
    },
    unblock(key: string) {
      db.update(peerPermissions)
        .set({ blockedAt: null })
        .where(eq(peerPermissions.publicKey, key))
        .run();
      blocked.delete(key);
      notify();
    },
  };
}

export type Privacy = ReturnType<typeof createPrivacy>;
