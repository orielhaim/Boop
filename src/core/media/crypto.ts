import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import {
  AESEncryptionKey,
  AESKeySize,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
} from "expo-crypto";
import { sha256 } from "./hash";
import { validateAttachment } from "./attachment-format";
import {
  byteLimit,
  type SealedAttachment,
  type AttachmentMetadata,
} from "./protocol";

export async function sealAttachment(
  plaintext: Uint8Array<ArrayBuffer>,
  metadata: AttachmentMetadata,
) {
  validateAttachment(plaintext, metadata);
  const key = await AESEncryptionKey.generate(AESKeySize.AES256);
  const sealed = await aesEncryptAsync(plaintext, key, {
    nonce: { length: 12 },
    tagLength: 16,
  });
  const bytes = Uint8Array.from(await sealed.ciphertext({ includeTag: true }));
  const file: SealedAttachment = {
    ...metadata,
    algorithm: "aes-gcm",
    key: await key.encoded("hex"),
    nonce: bytesToHex(await sealed.iv()),
    hash: await sha256(bytes),
    originalHash: await sha256(plaintext),
    size: bytes.length,
  };
  return { file, bytes };
}

export async function openAttachment(
  bytes: Uint8Array<ArrayBuffer>,
  file: SealedAttachment,
) {
  if (
    bytes.length < 17 ||
    bytes.length > byteLimit(file.kind) ||
    (file.size !== undefined && bytes.length !== file.size) ||
    (await sha256(bytes)) !== file.hash
  )
    throw new Error("media-integrity");
  let plaintext: Uint8Array;
  try {
    const key = await AESEncryptionKey.import(file.key, "hex");
    plaintext = await aesDecryptAsync(
      AESSealedData.fromParts(hexToBytes(file.nonce), bytes, 16),
      key,
    );
  } catch {
    throw new Error("media-integrity");
  }
  const audio = Uint8Array.from(plaintext);
  plaintext.fill(0);
  try {
    if (file.originalHash && (await sha256(audio)) !== file.originalHash)
      throw new Error("media-integrity");
    validateAttachment(audio, file);
    return audio;
  } catch (error) {
    audio.fill(0);
    throw error;
  }
}
