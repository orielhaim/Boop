import { requireOptionalNativeModule } from "expo";
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
  prepare(id: string): void;
  available(): boolean;
};
const native = requireOptionalNativeModule<NativeAvatarTransport>(
  "BoopAvatarTransport",
);

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
