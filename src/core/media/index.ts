import type { NDKSigner } from "@nostr-dev-kit/ndk";
import { fetch } from "expo/fetch";
import type { Database } from "@/db";
import { preference, setPreference } from "@/db/queries";
import {
  blossomCommand,
  downloadPreviewFile,
  nativeAvatarTransport,
} from "./download-native";
import { profileFiles } from "./files";
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
  const uploads = createMediaUploads(
    signer,
    {
      request: fetch,
      sha256,
      headUpload: async (url, headers, signal) =>
        (await blossomCommand(url, headers, signal)).status,
      mirrorCommand: blossomCommand,
    },
    settings,
    changed,
  );
  return {
    ...uploads,
    snapshot: settings.snapshot,
    configured: settings.configured,
    save(next: Parameters<typeof settings.save>[0]) {
      settings.save(next);
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
    profileDownload: nativeAvatarTransport,
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
