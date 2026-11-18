import { getRandomValues, randomUUID } from "expo-crypto";
import type { Database } from "@/db";
import type { MessagingRepository } from "@/db/messaging";
import { preference, setPreference } from "@/db/queries";
import { loadIdentitySigner } from "../identity";
import type { Identity } from "../identity/keys";

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
  // NDK's signatures and NIP-44 nonces require secure native entropy.
  // Expo's explicit getRandomValues avoids the dev-only getRandomBytes fallback.
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    if (!globalThis.crypto)
      Object.defineProperty(globalThis, "crypto", { value: {} });
    Object.defineProperty(globalThis.crypto, "getRandomValues", {
      value: getRandomValues,
    });
  }
  // NDK's older Noble dependency captures the global during module evaluation.
  const [{ createMessagingService }, signer] = await Promise.all([
    import("./runtime"),
    loadIdentitySigner(identity),
  ]);
  return createMessagingService({
    signer,
    chat,
    readState: (key) => preference(db, key),
    writeState: (key, value) => setPreference(db, key, value),
    createId: randomUUID,
  });
}
