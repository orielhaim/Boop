import { gcm } from "@noble/ciphers/aes.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { savedPlayback, type SavedPlayback } from "@/core/audio/types";

type PersistenceOptions = {
  account: string;
  key: Uint8Array;
  random(size: number): Uint8Array;
  read(key: string): string | null;
  write(key: string, value: string): void;
};

export function createMediaPersistence<T>(
  { account, key, random, read, write }: PersistenceOptions,
  slot: string,
  schema: { parse(input: unknown): T },
) {
  const aad = utf8ToBytes(JSON.stringify([slot, 1, account]));
  const queueKey = sha256(concatBytes(key, utf8ToBytes(slot)));
  return {
    load() {
      try {
        const encoded = read(slot);
        if (!encoded) return;
        const bytes = hexToBytes(encoded);
        const cipher = gcm(queueKey, bytes.subarray(0, 12), aad);
        return schema.parse(
          JSON.parse(
            new TextDecoder().decode(cipher.decrypt(bytes.subarray(12))),
          ),
        );
      } catch {
        return undefined;
      }
    },
    save(value: T) {
      const nonce = random(12);
      const cipher = gcm(queueKey, nonce, aad);
      write(
        slot,
        bytesToHex(
          concatBytes(
            nonce,
            cipher.encrypt(utf8ToBytes(JSON.stringify(value))),
          ),
        ),
      );
    },
  };
}

export function audioPersistence(options: PersistenceOptions) {
  return createMediaPersistence<SavedPlayback>(
    options,
    "audio.queue",
    savedPlayback,
  );
}
