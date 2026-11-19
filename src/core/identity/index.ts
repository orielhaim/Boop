import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getRandomBytesAsync } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { Database } from "@/db";
import { preference, setPreference } from "@/db/queries";
import { type Identity, loadIdentity } from "./keys";

const key = "boop.identity.v1";
const options = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function initializeIdentity(db: Database) {
  const pinnedKey = preference(db, "identity.publicKey");
  const identity = await loadIdentity(
    {
      read: () => SecureStore.getItemAsync(key, options),
      write: (secret) => SecureStore.setItemAsync(key, secret, options),
    },
    pinnedKey,
    () => getRandomBytesAsync(32),
  );
  if (pinnedKey === null)
    setPreference(db, "identity.publicKey", identity.publicKey);
  return identity;
}

export async function loadIdentitySigner(identity: Identity) {
  const secret = await SecureStore.getItemAsync(key, options);
  if (secret === null) throw new Error("Identity missing from secure storage");
  const signer = new NDKPrivateKeySigner(secret);
  if (signer.pubkey !== identity.publicKey)
    throw new Error("Identity mismatch");
  return signer;
}
