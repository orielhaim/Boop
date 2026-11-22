import { randomUUID } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import type { MediaSdk } from "@/core/media";
import { removeMediaFile, sweepFiles } from "@/core/media/files";
import type { Privacy } from "@/core/privacy";
import type { Database } from "@/db";
import { openLinkPreviewCache } from "@/db/link-previews";
import { createLinkPreviews } from "./link-previews";

const imageName = /^[a-f0-9-]{36}\.jpg$/u;

export function createNativeLinkPreviews(
  db: Database,
  privacy: Privacy,
  media: MediaSdk,
  authorizer: {
    authorizePreview(target: {
      peer: string;
      id: string;
      url: string;
    }): boolean;
    subscribe(listener: () => void): () => void;
  },
) {
  const root = new Directory(Paths.cache, "link-previews");
  const removeImage = (name: string) => {
    if (imageName.test(name)) removeMediaFile(new File(root, name));
  };
  const cache = openLinkPreviewCache(db, removeImage);
  sweepFiles(root, cache.images());
  async function transfer(url: string, image: boolean, signal: AbortSignal) {
    const id = randomUUID();
    const file = new File(root, `${id}.${image ? "jpg" : "html"}`);
    try {
      root.create({ idempotent: true, intermediates: true });
      const size = await media.downloadPreview(
        id,
        url,
        file.uri,
        image,
        signal,
      );
      if (signal.aborted || !size || file.size !== size)
        throw new Error("preview-unavailable");
      return file;
    } catch (error) {
      removeMediaFile(file);
      throw error;
    }
  }
  const previews = createLinkPreviews({
    ...cache,
    removeImage,
    policy: privacy.linkPreviewPolicy,
    authorize: authorizer.authorizePreview,
    async html(url, signal) {
      const file = await transfer(url, false, signal);
      try {
        return await file.text();
      } finally {
        removeMediaFile(file);
      }
    },
    async image(url, signal) {
      return (await transfer(url, true, signal)).name;
    },
  });
  privacy.subscribe(previews.revalidate);
  authorizer.subscribe(previews.revalidate);
  return {
    ...previews,
    imageUri(name: string | undefined) {
      if (!name || !imageName.test(name)) return;
      const file = new File(root, name);
      if (file.exists) return file.uri;
    },
  };
}
