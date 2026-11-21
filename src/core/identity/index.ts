import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getRandomBytesAsync } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { Database } from "@/db";
import { openMarmotAccount } from "../marmot/native";
import type { RelayConfiguration } from "../nostr/config";
import { encryptBackup } from "./backup";
import { loadPinnedIdentity, stageSwitch, storedSecret } from "./storage";

const options = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const storage = {
  read: (slot: string) => SecureStore.getItemAsync(slot, options),
  write: (slot: string, value: string) =>
    SecureStore.setItemAsync(slot, value, options),
  remove: (slot: string) => SecureStore.deleteItemAsync(slot, options),
};

export async function exportIdentity(db: Database, password: string) {
  return encryptBackup(await storedSecret(db, storage), password);
}

export function stageIdentity(db: Database, secret: string) {
  return stageSwitch(db, storage, secret);
}

export async function initializeMarmotIdentity(
  db: Database,
  key: string,
  relays: RelayConfiguration,
) {
  return openMarmotAccount(key, await storedSecret(db, storage), relays);
}

export async function initializeIdentity(db: Database) {
  const { identity, secret, fresh } = await loadPinnedIdentity(
    db,
    storage,
    () => getRandomBytesAsync(32),
  );
  const signer = new NDKPrivateKeySigner(secret);
  if (signer.pubkey !== identity.publicKey)
    throw new Error("Identity mismatch");
  return { identity, signer, fresh };
}
