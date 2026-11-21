import type { AttachmentMedia } from "../media/service";
import type { NDKSigner } from "@nostr-dev-kit/ndk";
import { randomUUID } from "expo-crypto";
import type { Privacy } from "@/core/privacy";
import type { Database } from "@/db";
import type { MessagingRepository } from "@/db/messaging";
import { preference, setPreference } from "@/db/queries";
import { createMessagingService } from "./runtime";

export type { MessagingStatus } from "./runtime";

export function createMessagingRuntime({
  db,
  signer,
  chat,
  privacy,
  media,
}: {
  db: Database;
  signer: NDKSigner;
  chat: MessagingRepository;
  privacy: Privacy;
  media: AttachmentMedia;
}) {
  return createMessagingService({
    signer,
    chat,
    privacy,
    media,
    readState: (key) => preference(db, key),
    writeState: (key, value) => setPreference(db, key, value),
    createId: randomUUID,
  });
}
