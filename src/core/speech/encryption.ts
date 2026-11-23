import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
} from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  speechKeySlot,
  type StoredTranscript,
  validateTranscript,
} from "./types";

export function createTranscriptEncryption(account: string) {
  const slot = speechKeySlot(account);
  const options = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
  const encode = (value: string) => new TextEncoder().encode(value);
  let key: ReturnType<typeof AESEncryptionKey.import> | undefined;
  function getKey(create: boolean) {
    if (key) return key;
    const pending = (async () => {
      const stored = await SecureStore.getItemAsync(slot, options);
      if (stored) return AESEncryptionKey.import(stored, "base64");
      if (!create) throw new Error("Speech storage key unavailable");
      const generated = await AESEncryptionKey.generate();
      await SecureStore.setItemAsync(
        slot,
        await generated.encoded("base64"),
        options,
      );
      return generated;
    })().catch((error) => {
      if (key === pending) key = undefined;
      throw error;
    });
    key = pending;
    return pending;
  }
  const aad = (id: string) => encode(JSON.stringify([slot, id]));
  return {
    async clear() {
      key = undefined;
      await SecureStore.deleteItemAsync(slot, options);
    },
    async seal(id: string, transcript: StoredTranscript) {
      const sealed = await aesEncryptAsync(
        encode(JSON.stringify(transcript)),
        await getKey(true),
        {
          additionalData: aad(id),
        },
      );
      return sealed.combined("base64");
    },
    async open(id: string, payload: string) {
      const plain = await aesDecryptAsync(
        AESSealedData.fromCombined(payload),
        await getKey(false),
        {
          additionalData: aad(id),
        },
      );
      return validateTranscript(JSON.parse(new TextDecoder().decode(plain)));
    },
  };
}
