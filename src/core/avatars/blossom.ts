import type { File } from "expo-file-system";
import type { MediaSdk } from "../media";
import { BlossomError } from "../media/blossom";
import { maxAvatarBytes, sanitizeAvatarJpeg } from "./jpeg";

export { BlossomError } from "../media/blossom";

export async function uploadAvatar(
  media: MediaSdk,
  file: File,
  signal: AbortSignal,
) {
  if (!file.exists || file.size > maxAvatarBytes)
    throw new BlossomError("format");
  const bytes = await file.bytes();
  let clean: Uint8Array<ArrayBuffer>;
  try {
    clean = sanitizeAvatarJpeg(bytes).bytes;
  } catch {
    throw new BlossomError("format");
  }
  if (clean.length !== bytes.length) throw new BlossomError("format");
  return media.upload("profile", clean, { signal });
}
