import type { ProfilePhotoPolicy } from "@/core/avatars/protocol";
import { eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { preference, setPreference } from "@/db/queries";
import type * as schema from "@/db/schema";
import { contacts, peerPermissions } from "@/db/schema";
import type { BlockedUsers } from "./marmot/blocked-users";
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

export function createPrivacy<Result>(
  db: BaseSQLiteDatabase<"sync", Result, typeof schema>,
  blocks: BlockedUsers,
) {
  const listeners = new Set<() => void>();
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
  blocks.subscribe(notify);
  const { isBlocked } = blocks;
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
    blocks,
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
    messagePermission(key: string): "blocked" | "allow" | "request" | "reject" {
      if (isBlocked(key)) return "blocked";
      const grant = db
        .select()
        .from(peerPermissions)
        .where(eq(peerPermissions.publicKey, key))
        .get();
      if (grant?.initiated) return "allow";
      if (preferences.messages === "initiated") return "reject";
      if (
        grant?.approved ||
        (preferences.messages === "everyone" && !preferences.requests) ||
        isContact(key)
      )
        return "allow";
      return preferences.requests ? "request" : "reject";
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
  };
}

export type Privacy = ReturnType<typeof createPrivacy>;
