import { parseServerOrigins, serverListKind } from "./servers";
import type { RelayService } from "../nostr/relay-service";

export function createBlossomServerList(
  relays: RelayService,
  publicKey: string,
  canPublishMedia: () => boolean,
) {
  const { transport, connectedRelays } = relays;
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

  return {
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
      const event = await transport.publishServerList(
        selected.map((origin) => ["server", origin]),
        timestamp,
        relays.configuration().write,
        active,
      );
      return Boolean(event);
    },
  };
}
