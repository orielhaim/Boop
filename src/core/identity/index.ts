import { NDKUser, type NDKSigner } from "@nostr-dev-kit/ndk";
import { getRandomBytesAsync } from "expo-crypto";
import { Directory, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { removeAccountDatabase, type Database } from "@/db";
import { preference, setPreference } from "@/db/queries";
import {
  marmotAccounts,
  type IdentityInput,
  type MarmotRelays,
} from "../marmot/native";
import { speechKeySlot } from "../speech/types";

const selected = "account.selected";
const settings = ["language", "theme", "haptics", "security.appLock"];
const options = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const downloadSlot = (account: string) => `boop.downloads.v2.${account}`;

export function copyInstallationPreferences(
  source: Database,
  target: Database,
) {
  target.transaction((tx) => {
    for (const setting of settings) {
      const value = preference(source, setting);
      if (value !== null) setPreference(tx, setting, value);
    }
  });
}

export function selectAccount(db: Database, account: string) {
  setPreference(db, selected, account);
}

export function clearSelectedAccount(db: Database) {
  setPreference(db, selected, "");
}

export async function selectedAccount(db: Database, relays: MarmotRelays) {
  const accounts = await marmotAccounts.list(relays, null);
  const key = preference(db, selected);
  const account = accounts.find((candidate) => candidate.key === key);
  if (key && !account) throw new IdentityMismatchError();
  if (!key && accounts.length > 1) throw new IdentityMismatchError();
  // The import may commit its MDK checkpoint before Boop saves the selection.
  if (
    account &&
    !account.signedOut &&
    !account.unlinked &&
    account.readiness !== "initializing"
  ) {
    const imports = accounts.filter(
      (candidate) =>
        candidate.key !== account.key &&
        !candidate.signedOut &&
        !candidate.unlinked &&
        candidate.readiness === "initializing",
    );
    if (imports.length === 1) {
      selectAccount(db, imports[0].key);
      return { account: imports[0], accounts };
    }
  }
  return { account: account ?? accounts[0], accounts };
}

export class IdentityMismatchError extends Error {
  constructor() {
    super("Selected Marmot account is missing");
  }
}

export async function createOrImportIdentity(
  db: Database,
  input: IdentityInput,
  relays: MarmotRelays,
) {
  if (!("importToken" in input)) {
    const name = input.name.trim();
    const about = input.about.trim();
    if (!name || name.length > 128 || about.length > 1000)
      throw new Error("Invalid profile");
    input = { name, about };
  }
  const key = await marmotAccounts.install(input, relays);
  selectAccount(db, key);
  return key;
}

export async function accountDownloadKey(account: string) {
  const slot = downloadSlot(account);
  const stored = await SecureStore.getItemAsync(slot, options);
  if (stored !== null) {
    if (!/^[a-f0-9]{64}$/.test(stored))
      throw new Error("Invalid download storage key");
    return hexToBytes(stored);
  }
  const key = await getRandomBytesAsync(32);
  try {
    await SecureStore.setItemAsync(slot, bytesToHex(key), options);
    return key;
  } catch (error) {
    key.fill(0);
    throw error;
  }
}

export async function removeLocalAccount(account: string) {
  const stored = await SecureStore.getItemAsync(downloadSlot(account), options);
  if (stored && /^[a-f0-9]{64}$/u.test(stored)) {
    const key = hexToBytes(stored);
    try {
      const files = new Directory(
        Paths.document,
        "torrent-downloads",
        bytesToHex(sha256(key)),
      );
      if (files.exists) files.delete();
    } finally {
      key.fill(0);
    }
  }
  await Promise.all([
    SecureStore.deleteItemAsync(downloadSlot(account), options),
    SecureStore.deleteItemAsync(speechKeySlot(account), options),
  ]);
  await removeAccountDatabase(account);
  await marmotAccounts.remove(account);
}

export function accountSigner(
  key: string,
  available: () => boolean,
): NDKSigner {
  const user = new NDKUser({ pubkey: key });
  async function authorize<T>(operation: () => Promise<T>) {
    if (!available()) throw new Error("AccountClosed");
    const result = await operation();
    if (!available()) throw new Error("AccountClosed");
    return result;
  }
  return {
    pubkey: key,
    userSync: user,
    user: async () => user,
    blockUntilReady: async () => user,
    sign: (event) =>
      authorize(() => marmotAccounts.sign(key, JSON.stringify(event))),
    encryptionEnabled: async (scheme) =>
      scheme ? [scheme] : ["nip04", "nip44"],
    encrypt: (peer, value, scheme) =>
      authorize(() =>
        marmotAccounts.cipher(
          key,
          peer.pubkey,
          value,
          scheme === "nip44",
          true,
        ),
      ),
    decrypt: (peer, value, scheme) =>
      authorize(() =>
        marmotAccounts.cipher(
          key,
          peer.pubkey,
          value,
          scheme === "nip44",
          false,
        ),
      ),
    toPayload() {
      throw new Error("Account signer cannot be serialized");
    },
  };
}

export function backupKind(input: string) {
  const value = input
    .trim()
    .replace(/^nostr:/i, "")
    .toLowerCase();
  return value.startsWith("ncryptsec1") ? "encrypted" : "raw";
}
