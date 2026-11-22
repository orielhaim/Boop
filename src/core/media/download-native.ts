import { requireOptionalNativeModule } from "expo";
import { randomUUID } from "expo-crypto";
import type { AvatarTransport } from "../avatars/service";

type NativeAvatarTransport = Pick<AvatarTransport, "cancel"> & {
  download(
    id: string,
    url: string,
    output: string,
    hash: string | null,
    attachmentLimit: number | null,
  ): Promise<number>;
  downloadPreview?(
    id: string,
    url: string,
    output: string,
    image: boolean,
  ): Promise<number>;
  downloadNip05?(id: string, url: string, output: string): Promise<number>;
  prepare(id: string): void;
  blossomCommand(
    id: string,
    url: string,
    headers: Record<string, string>,
    body: string | null,
  ): Promise<{ status: number; body: string }>;
  available(): boolean;
};
const native = requireOptionalNativeModule<NativeAvatarTransport>(
  "BoopAvatarTransport",
);

export async function blossomCommand(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  body: string | null = null,
) {
  if (!native?.available() || signal.aborted)
    throw new Error("UploadCheckUnavailable");
  const id = randomUUID();
  native.prepare(id);
  const cancel = () => native.cancel(id);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await native.blossomCommand(id, url, headers, body);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function downloadPreviewFile(
  id: string,
  url: string,
  output: string,
  image: boolean,
  signal: AbortSignal,
) {
  if (!native?.available?.() || !native.downloadPreview || signal.aborted)
    throw new Error("preview-unavailable");
  native.prepare(id);
  const cancel = () => native.cancel(id);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await native.downloadPreview(id, url, output, image);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function downloadNip05(
  id: string,
  url: string,
  output: string,
  signal: AbortSignal,
) {
  if (!native?.available() || !native.downloadNip05 || signal.aborted)
    throw new Error("NIP-05 lookup unavailable");
  native.prepare(id);
  const cancel = () => native.cancel(id);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await native.downloadNip05(id, url, output);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export const nativeAvatarTransport: AvatarTransport | null =
  native?.available?.() && native
    ? {
        download(id, url, destination, hash) {
          native.prepare(id);
          return native.download(id, url, destination, hash ?? null, null);
        },
        cancel(id) {
          native.cancel(id);
        },
      }
    : null;
