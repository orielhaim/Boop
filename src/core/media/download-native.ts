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
  addListener(
    event: "attachmentProgress",
    listener: (event: { id: string; received: number; total: number }) => void,
  ): { remove(): void };
  prepare(id: string): void;
  available(): boolean;
};
const native = requireOptionalNativeModule<NativeAvatarTransport>(
  "BoopAvatarTransport",
);

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

export async function downloadEncryptedBlob(
  id: string,
  url: string,
  destination: string,
  hash: string,
  limit: number,
  signal: AbortSignal,
  onProgress: (percent: number) => void,
) {
  if (!native?.available?.() || signal.aborted) throw new Error("unavailable");
  native.prepare(id);
  const cancel = () => native.cancel(id);
  signal.addEventListener("abort", cancel, { once: true });
  const subscription = native.addListener("attachmentProgress", (event) => {
    if (event.id === id && event.total > 0) {
      onProgress(
        Math.max(
          0,
          Math.min(99, Math.floor((100 * event.received) / event.total)),
        ),
      );
    }
  });
  const timeout = setTimeout(cancel, 16_000);
  try {
    return await native.download(id, url, destination, hash, limit);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("MEDIA_MISSING") ||
        ("code" in error && error.code === "MEDIA_MISSING"))
    )
      throw new Error("missing");
    if (
      error instanceof Error &&
      (error.message.includes("MEDIA_INTEGRITY") ||
        ("code" in error && error.code === "MEDIA_INTEGRITY"))
    )
      throw new Error("media-integrity");
    throw new Error("media-download");
  } finally {
    clearTimeout(timeout);
    subscription.remove();
    signal.removeEventListener("abort", cancel);
  }
}
