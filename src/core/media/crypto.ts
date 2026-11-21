import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";
import { getRandomBytesAsync } from "expo-crypto";
import { FileMode, Paths, type File, type FileHandle } from "expo-file-system";
import { validateAttachmentFile } from "./file-format";
import { removeMediaFile } from "./files";
import {
  byteLimit,
  type SealedAttachment,
  type AttachmentMetadata,
} from "./protocol";

const chunkSize = 64 * 1024;
const tagSize = 16;

function cryptoEngine(): typeof import("react-native-quick-crypto") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("react-native-quick-crypto");
}

function checkLive(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("media-cancelled");
}

async function traverse(
  input: FileHandle,
  length: number,
  consume: (bytes: Uint8Array<ArrayBuffer>) => void | Promise<void>,
  signal?: AbortSignal,
) {
  for (let remaining = length; remaining > 0;) {
    checkLive(signal);
    const bytes = await input.readBytes(Math.min(chunkSize, remaining));
    if (!bytes.length) throw new Error("media-integrity");
    try {
      await consume(bytes);
    } finally {
      bytes.fill(0);
    }
    remaining -= bytes.length;
  }
  checkLive(signal);
}

export async function hashAttachmentFile(source: File, signal?: AbortSignal) {
  const hash = cryptoEngine().createHash("sha256");
  const input = source.open(FileMode.ReadOnly);
  try {
    await traverse(
      input,
      input.size ?? 0,
      (chunk) => {
        hash.update(chunk);
      },
      signal,
    );
    return hash.digest("hex");
  } finally {
    input.close();
  }
}

async function withOutput<T>(
  source: File,
  target: File,
  expectedSize: number,
  run: (input: FileHandle, output: FileHandle) => Promise<T>,
) {
  if (Paths.availableDiskSpace < expectedSize) throw new Error("media-storage");
  const input = source.open(FileMode.ReadOnly);
  try {
    target.create();
    try {
      const output = target.open(FileMode.WriteOnly);
      try {
        const result = await run(input, output);
        if (output.size !== expectedSize) throw new Error("media-storage");
        return result;
      } finally {
        output.close();
      }
    } catch (error) {
      removeMediaFile(target);
      throw error;
    }
  } finally {
    input.close();
  }
}

export async function sealAttachment(
  source: File,
  target: File,
  metadata: AttachmentMetadata,
  signal?: AbortSignal,
): Promise<SealedAttachment> {
  validateAttachmentFile(source, metadata);
  const length = source.size;
  if (!length || length > byteLimit(metadata.kind) - tagSize)
    throw new Error("media-size");
  const size = length + tagSize;
  const { createCipheriv, createHash } = cryptoEngine();
  const key = await getRandomBytesAsync(32);
  try {
    const nonce = await getRandomBytesAsync(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = createHash("sha256");
    const original = createHash("sha256");
    await withOutput(source, target, size, async (input, output) => {
      if (input.size !== length) throw new Error("media-integrity");
      const write = async (bytes: Uint8Array<ArrayBuffer>) => {
        encrypted.update(bytes);
        if (bytes.length) await output.writeBytes(bytes);
      };
      await traverse(
        input,
        length,
        async (chunk) => {
          original.update(chunk);
          await write(cipher.update(chunk));
        },
        signal,
      );
      await write(cipher.final());
      await write(cipher.getAuthTag());
    });
    try {
      const hash = encrypted.digest("hex");
      if ((await hashAttachmentFile(target, signal)) !== hash)
        throw new Error("media-integrity");
      return {
        ...metadata,
        algorithm: "aes-gcm",
        key: bytesToHex(key),
        nonce: bytesToHex(nonce),
        hash,
        originalHash: original.digest("hex"),
        size,
      };
    } catch (error) {
      removeMediaFile(target);
      throw error;
    }
  } finally {
    key.fill(0);
  }
}

export async function openAttachment(
  source: File,
  target: File,
  file: SealedAttachment,
  signal?: AbortSignal,
) {
  const size = source.size;
  if (
    size <= tagSize ||
    size > byteLimit(file.kind) ||
    (file.size !== undefined && size !== file.size)
  )
    throw new Error("media-integrity");
  const { createDecipheriv, createHash } = cryptoEngine();
  const key = hexToBytes(file.key);
  try {
    const nonce = hexToBytes(file.nonce);
    if (key.length !== 32 || (nonce.length !== 12 && nonce.length !== 16))
      throw new Error("media-integrity");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    const encrypted = createHash("sha256");
    const original = createHash("sha256");
    const length = size - tagSize;
    await withOutput(source, target, length, async (input, output) => {
      if (input.size !== size) throw new Error("media-integrity");
      const write = async (clear: Uint8Array<ArrayBuffer>) => {
        try {
          original.update(clear);
          if (clear.length) await output.writeBytes(clear);
        } finally {
          clear.fill(0);
        }
      };
      await traverse(
        input,
        length,
        async (chunk) => {
          encrypted.update(chunk);
          await write(decipher.update(chunk));
        },
        signal,
      );
      const tag = await input.readBytes(tagSize);
      encrypted.update(tag);
      if (tag.length !== tagSize || encrypted.digest("hex") !== file.hash)
        throw new Error("media-integrity");
      try {
        decipher.setAuthTag(cipherBuffer(tag));
        await write(decipher.final());
      } catch {
        throw new Error("media-integrity");
      }
      if (file.originalHash && original.digest("hex") !== file.originalHash)
        throw new Error("media-integrity");
    });
    try {
      checkLive(signal);
      validateAttachmentFile(target, file);
    } catch (error) {
      removeMediaFile(target);
      throw error;
    }
  } finally {
    key.fill(0);
  }
}

function cipherBuffer(tag: Uint8Array<ArrayBuffer>) {
  // Quick Crypto uses the same Buffer export for cipher inputs and tags.
  return cryptoEngine().Buffer.from(tag);
}
