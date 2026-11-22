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
  async function readMediaList() {
    return transport.lookupLists(publicKey, listRelays(), [serverListKind]);
  }

  return {
    profileRelayKey: () =>
      discoveryRelays()
        .slice(0, 4)
        .map((relay) => relay.url)
        .join(","),
    watchProfiles(
      authors: string[],
      onEvent: (event: unknown, author: string) => void,
      onEose: () => void,
    ) {
      const targets = discoveryRelays().slice(0, 4);
      return targets.length
        ? transport.watchProfiles(targets, authors, onEvent, onEose)
        : null;
    },
    async discoverBlossomServers() {
      const { general, complete } = await readMediaList();
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
        () => session === relays.generation(),
      );
    },
  };
}
