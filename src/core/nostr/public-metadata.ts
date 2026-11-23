import { parseServerOrigins, serverListKind } from "../media/servers";
import type { RelayService } from "./relay-service";

export function createPublicMetadata(
  relays: RelayService,
  publicKey: string,
  canPublishMedia: () => boolean,
) {
  const { transport, connectedRelays, discoveryRelays } = relays;
  let lastMediaList = 0;
  const listRelays = () => {
    const targets = new Set([
      ...relays.configuration().general,
      ...relays.configuration().discovery,
    ]);
    return connectedRelays()
      .filter((relay) => targets.has(relay.url))
      .slice(0, 8);
  };
  async function readMediaList(author = publicKey) {
    return transport.lookupLists(author, listRelays(), [serverListKind]);
  }

  const profileRelays = () =>
    [...new Set([...discoveryRelays(), ...listRelays()])].slice(0, 4);
  return {
    searchProfiles(
      query: string,
      onEvent: (event: unknown, author: string) => void,
      onEose: () => void,
    ) {
      const targets = discoveryRelays().slice(0, 4);
      return targets.length && canPublishMedia()
        ? transport.searchProfiles(targets, query, onEvent, onEose)
        : null;
    },
    lookupProfileHints: transport.lookupProfileHints,
    profileRelayKey: () =>
      profileRelays()
        .map((relay) => relay.url)
        .join(","),
    watchProfiles(
      authors: string[],
      onEvent: (event: unknown, author: string) => void,
      onEose: () => void,
    ) {
      const targets = profileRelays();
      return targets.length
        ? transport.watchProfiles(targets, authors, onEvent, onEose)
        : null;
    },
    watchOwnProfile(
      onEvent: (event: unknown, author: string) => void,
      onEose: (allReplied: boolean) => void,
    ) {
      const targets = profileRelays();
      if (!targets.length) return null;
      let remaining = targets.length;
      // A stalled relay must not hide a healthy relay's EOSE from the editor.
      const stops = targets.map((relay) =>
        transport.watchProfiles([relay], [publicKey], onEvent, () =>
          onEose(--remaining === 0),
        ),
      );
      return () => stops.forEach((stop) => stop());
    },
    async discoverBlossomServers(author?: string) {
      const { general, complete } = await readMediaList(author);
      if (!complete && !general) throw new Error("media-list-unavailable");
      return parseServerOrigins(general?.tags ?? []);
    },
    async publishBlossomServers(origins: string[]) {
      const session = relays.generation();
      const active = () => session === relays.generation() && canPublishMedia();
      const selected = parseServerOrigins(
        origins.map((origin) => ["server", origin]),
      );
      if (!selected.length || !active()) return false;
      const { general, complete } = await readMediaList();
      if (!complete || !active()) return false;
      const now = Math.floor(Date.now() / 1_000);
      const timestamp = Math.max(
        now,
        (general?.created_at ?? 0) + 1,
        lastMediaList + 1,
      );
      if (timestamp > now + 60) return false;
      lastMediaList = timestamp;
      const event = await transport.publishReplaceable(
        serverListKind,
        "",
        selected.map((origin) => ["server", origin]),
        timestamp,
        relays.configuration().general,
        active,
      );
      return Boolean(event);
    },
    publishProfile(content: string, createdAt: number) {
      const session = relays.generation();
      return transport.publishReplaceable(
        0,
        content,
        [],
        createdAt,
        relays.configuration().general,
        () => session === relays.generation() && canPublishMedia(),
      );
    },
  };
}
