import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getRandomBytesAsync } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { Database } from "@/db";
import { preference, setPreference } from "@/db/queries";
import { loadIdentity } from "./keys";

const key = "boop.identity.v1";
const options = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function initializeIdentity(db: Database) {
  const pinnedKey = preference(db, "identity.publicKey");
  let secret = await SecureStore.getItemAsync(key, options);
  const identity = await loadIdentity(
    {
      read: async () => secret,
      write: async (value) => {
        await SecureStore.setItemAsync(key, value, options);
        secret = value;
      },
    },
    pinnedKey,
    () => getRandomBytesAsync(32),
  );
  if (secret === null) throw new Error("Identity missing from secure storage");
  const signer = new NDKPrivateKeySigner(secret);
  if (signer.pubkey !== identity.publicKey)
    throw new Error("Identity mismatch");
  const fresh = pinnedKey === null;
  if (fresh) setPreference(db, "identity.publicKey", identity.publicKey);
  return { identity, signer, fresh };
}
