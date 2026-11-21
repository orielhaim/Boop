import type { NDKSigner } from "@nostr-dev-kit/ndk";
import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import type { File } from "expo-file-system";
import { fetch } from "expo/fetch";
import { BlossomError, blossomServer, putAvatar } from "./blossom-protocol";
import { maxAvatarBytes } from "./jpeg";

export {
  BlossomError,
  blossomServer,
  defaultBlossomServer,
} from "./blossom-protocol";

export async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(
    new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function uploadAvatar(
  signer: NDKSigner,
  origin: string,
  file: File,
  signal: AbortSignal,
) {
  if (!file.exists || file.size > maxAvatarBytes)
    throw new BlossomError("format");
  return putAvatar(signer, origin, await file.bytes(), signal, {
    request: fetch,
    sha256,
  });
}

export async function probeBlossom(origin: string) {
  const server = blossomServer(origin);
  if (!server) return "unavailable";
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 6_000);
  try {
    const response = await fetch(`${server}/upload`, {
      method: "HEAD",
      credentials: "omit",
      redirect: "error",
      signal: abort.signal,
    });
    if (response.status === 401 || response.status === 403)
      return "requiresAuth";
    return response.ok ? "reachable" : "unavailable";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}
