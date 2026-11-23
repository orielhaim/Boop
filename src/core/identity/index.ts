import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getRandomBytesAsync } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { Database } from "@/db";
import { preference } from "@/db/queries";
import { openMarmotAccount, type MarmotRelays } from "../marmot/native";
import { deriveIdentity } from "./keys";
import { encryptBackup } from "./backup";
import {
  findPinnedIdentity,
  installFirstIdentity,
  stageSwitch,
  storedSecret,
} from "./storage";

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
  relays: MarmotRelays,
  mediaOrigin: string | null,
) {
  return openMarmotAccount(
    key,
    await storedSecret(db, storage),
    relays,
    mediaOrigin,
    preference(db, "profile.initialBackup") === key,
  );
}

export async function initializeIdentity(db: Database) {
  const loaded = await findPinnedIdentity(db, storage);
  if (!loaded) return null;
  const { identity, secret, fresh } = loaded;
  const signer = new NDKPrivateKeySigner(secret);
  if (signer.pubkey !== identity.publicKey)
    throw new Error("Identity mismatch");
  return { identity, signer, fresh };
}

let installing = false;

export async function createOrImportIdentity(
  db: Database,
  input: { name: string; about: string } | { secret: string },
) {
  if (installing) throw new Error("Identity setup already running");
  installing = true;
  try {
    if ("secret" in input) {
      await installFirstIdentity(db, storage, input.secret, "");
      return;
    }
    const name = input.name.trim();
    const about = input.about.trim();
    if (!name || name.length > 128 || about.length > 1000)
      throw new Error("Invalid profile");
    for (let attempt = 0; attempt < 4; attempt++) {
      const bytes = await getRandomBytesAsync(32);
      const secret = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      bytes.fill(0);
      try {
        deriveIdentity(secret);
      } catch {
        continue;
      }
      await installFirstIdentity(
        db,
        storage,
        secret,
        JSON.stringify({ name, about, photo: { kind: "unchanged" } }),
      );
      return;
    }
    throw new Error("Could not generate a valid identity");
  } finally {
    installing = false;
  }
}
