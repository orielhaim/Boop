import { CryptoDigestAlgorithm, digest } from "expo-crypto";

export async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(
    new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
