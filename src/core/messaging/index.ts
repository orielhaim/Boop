import { randomUUID } from "expo-crypto";
import type { Database } from "@/db";
import type { MessagingRepository } from "@/db/messaging";
import { preference, setPreference } from "@/db/queries";
import { loadIdentitySigner } from "../identity";
import type { Identity } from "../identity/keys";
import { createMessagingService } from "./runtime";

export type { MessagingStatus } from "./runtime";

export async function createMessagingRuntime({
  db,
  identity,
  chat,
}: {
  db: Database;
  identity: Identity;
  chat: MessagingRepository;
}) {
  const signer = await loadIdentitySigner(identity);
  const messaging = createMessagingService({
    signer,
    chat,
    readState: (key) => preference(db, key),
    writeState: (key, value) => setPreference(db, key, value),
    createId: randomUUID,
  });
  return { messaging, signer };
}
