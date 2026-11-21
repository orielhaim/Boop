import { createBlobCache } from "./blob-cache";
import type { NDKSigner } from "@nostr-dev-kit/ndk";
import { fetch } from "expo/fetch";
import type { Database } from "@/db";
import { preference, setPreference } from "@/db/queries";
import {
  downloadEncryptedBlob,
  downloadPreviewFile,
  nativeAvatarTransport,
} from "./download-native";
import { createAttachmentTransfers } from "./attachment-transfers";
import { attachmentFiles, profileFiles } from "./files";
import { sha256 } from "./hash";
import { createMediaSettings } from "./servers";
import { createMediaUploads } from "./uploads";

export type MediaSdk = ReturnType<typeof createMediaSdk>;

export function createMediaSdk(db: Database, signer: NDKSigner) {
  const owner = signer.userSync.pubkey;
  const settings = createMediaSettings({
    read: (key) => preference(db, key),
    write: (key, value) => setPreference(db, key, value),
  });
  let revision = 0;
  const listeners = new Set<() => void>();
  function changed() {
    revision++;
    for (const listener of listeners) listener();
  }
  const transfers = createAttachmentTransfers(db, owner, (origin) =>
    settings
      .configured("attachment")
      .some((server) => server.origin === origin),
  );
  const uploads = createMediaUploads(
    signer,
    { request: fetch, sha256, putFile: transfers.put },
    settings,
    changed,
  );
  return {
    ...uploads,
    transfers,
    snapshot: settings.snapshot,
    configured: settings.configured,
    save(next: Parameters<typeof settings.save>[0]) {
      settings.save(next);
      const allowed = new Set(
        settings.configured("attachment").map(({ origin }) => origin),
      );
      transfers.revoke((row) => !allowed.has(row.origin));
      changed();
    },
    revision: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    profileFiles: profileFiles(owner),
    blobCache: createBlobCache(db, owner, attachmentFiles(owner)),
    profileDownload: nativeAvatarTransport,
    downloadExplicit: downloadEncryptedBlob,
    downloadPreview: downloadPreviewFile,
    profileMirrors(from: string) {
      if (!settings.snapshot().mirror) return [];
      const servers = settings
        .configured("profile")
        .map((server) => server.origin);
      return servers.includes(from)
        ? servers.filter((origin) => origin !== from)
        : [];
    },
  };
}
