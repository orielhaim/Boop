import type { NDKSigner } from "@nostr-dev-kit/ndk";
import { randomUUID } from "expo-crypto";
import type { Database } from "@/db";
import type { MessagingRepository } from "@/db/messaging";
import { preference, setPreference } from "@/db/queries";
import { createMessagingService } from "./runtime";

export type { MessagingStatus } from "./runtime";

export function createMessagingRuntime({
  db,
  signer,
  chat,
}: {
  db: Database;
  signer: NDKSigner;
  chat: MessagingRepository;
}) {
  return createMessagingService({
    signer,
    chat,
    readState: (key) => preference(db, key),
    writeState: (key, value) => setPreference(db, key, value),
    createId: randomUUID,
  });
}
