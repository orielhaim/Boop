import type { NativeIntent } from "expo-router";
import { acceptsLiveLink } from "@/services/local";
import { isIncomingMediaIntentUri } from "@/core/video/intent";

import { parsePublicIdentity } from "@/core/identity/keys";

export const redirectSystemPath: NonNullable<
  NativeIntent["redirectSystemPath"]
> = ({ path, initial }) => {
  if (!initial && !acceptsLiveLink()) return null;
  if (isIncomingMediaIntentUri(path))
    return `/incoming-file?uri=${encodeURIComponent(path)}`;
  if (!/^nostr:/i.test(path)) return path;
  const identity = parsePublicIdentity(path);
  return identity
    ? `/person/${identity.key}?reference=${encodeURIComponent(path)}`
    : "/";
};
