import { gcm } from "@noble/ciphers/aes.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { savedPlayback, type SavedPlayback } from "@/core/audio/types";

export function audioPersistence({
  account,
  key,
  random,
  read,
  write,
}: {
  account: string;
  key: Uint8Array;
  random(size: number): Uint8Array;
  read(key: string): string | null;
  write(key: string, value: string): void;
}) {
  const slot = "audio.queue";
  const aad = utf8ToBytes(JSON.stringify([slot, 1, account]));
  const queueKey = sha256(concatBytes(key, utf8ToBytes(slot)));
  return {
    load() {
      try {
        const encoded = read(slot);
        if (!encoded) return;
        const bytes = hexToBytes(encoded);
        const cipher = gcm(queueKey, bytes.subarray(0, 12), aad);
        return savedPlayback.parse(
          JSON.parse(
            new TextDecoder().decode(cipher.decrypt(bytes.subarray(12))),
          ),
        );
      } catch {
        return undefined;
      }
    },
    save(value: SavedPlayback) {
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
