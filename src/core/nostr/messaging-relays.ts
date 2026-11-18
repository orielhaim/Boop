import NDK, {
  type NDKAuthPolicy,
  NDKEvent,
  type NDKFilter,
  NDKRelay,
  NDKRelayAuthPolicies,
  NDKRelaySet,
  NDKRelayStatus,
  type NDKSigner,
} from "@nostr-dev-kit/ndk";
import {
  giftWrapKind,
  inboxListKind,
  type Rumor,
  verifiedEvent,
  wrapRumor,
} from "../messaging/nip17";
import { isPublicRelayAddress, secureRelays } from "./relays";

const timeout = 7_000;
const connected = (relay: NDKRelay) => relay.status >= NDKRelayStatus.CONNECTED;

export function createMessagingRelays(signer: NDKSigner) {
  const ndk = new NDK({
    enableOutboxModel: false,
    autoConnectUserRelays: false,
  });
  const configured = new Set<string>();
  const known = new Map<string, NDKRelay>();
  const publishing = new Map<NDKRelay, number>();
  const discoveryRequests = new Set<() => void>();
  const signIn = NDKRelayAuthPolicies.signIn({ signer });
  const auth: NDKAuthPolicy = async (relay, challenge) => {
    if (!configured.has(relay.url)) return undefined;
    return signIn(relay, challenge);
  };

  function getRelay(url: string) {
    let relay = known.get(url);
    if (!relay) {
      relay = new NDKRelay(url, auth, ndk);
      known.set(url, relay);
    }
    return relay;
  }

  function disconnect(relay: NDKRelay) {
    relay.connectivity.resetReconnectionState();
    relay.disconnect();
  }

  function connect(relay: NDKRelay) {
    return relay.connect(timeout, false).catch(() => undefined);
  }

  function addConfigured(url: string) {
    const relay = getRelay(url);
    configured.add(relay.url);
    ndk.pool.addRelay(relay, false);
    return relay;
  }

  function unconfigure(relay: NDKRelay) {
    configured.delete(relay.url);
    disconnect(relay);
    ndk.pool.removeRelay(relay.url);
  }

  function subscription(
    relays: NDKRelay[],
    filters: NDKFilter,
    onEvent: (event: NDKEvent) => void,
    onEose: () => void,
    closeOnEose = false,
  ) {
    const sub = ndk.subscribe(
      filters,
      {
        closeOnEose,
        groupable: false,
        relaySet: new NDKRelaySet(new Set(relays), ndk),
        onEvent,
        onEose,
      },
      false,
    );
    sub.start();
    return () => sub.stop();
  }

  function watchInbox(
    relay: NDKRelay,
    since: number | undefined,
    onEvent: (event: unknown) => void,
    onEose: () => void,
  ) {
    return subscription(
      [relay],
      { kinds: [giftWrapKind], "#p": [signer.userSync.pubkey], since },
      (event) => onEvent(event.rawEvent()),
      onEose,
    );
  }

  function findInbox(
    peerKey: string,
    discovery: NDKRelay[],
  ): Promise<string[]> {
    if (discovery.length === 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      let latest: ReturnType<typeof verifiedEvent> = null;
      let stop: (() => void) | undefined;
      const deadline = setTimeout(finish, timeout);
      function cancel() {
        finish(true);
      }
      function finish(cancelled = false) {
        if (!discoveryRequests.delete(cancel)) return;
        clearTimeout(deadline);
        stop?.();
        if (cancelled) {
          resolve([]);
          return;
        }
        const urls =
          latest?.tags.flatMap(([tag, url]) =>
            tag === "relay" && url ? [url] : [],
          ) ?? [];
        resolve(
          secureRelays(urls)
            .filter((url) => configured.has(url) || isPublicRelayAddress(url))
            .slice(0, 3),
        );
      }
      discoveryRequests.add(cancel);
      stop = subscription(
        discovery,
        { kinds: [inboxListKind], authors: [peerKey], limit: 8 },
        (event) => {
          const candidate = verifiedEvent(event.rawEvent());
          if (
            candidate?.kind !== inboxListKind ||
            candidate.pubkey !== peerKey ||
            candidate.created_at > Date.now() / 1_000 + 60
          )
            return;
          if (
            !latest ||
            candidate.created_at > latest.created_at ||
            (candidate.created_at === latest.created_at &&
              candidate.id < latest.id)
          )
            latest = candidate;
        },
        () => finish(),
        true,
      );
    });
  }

  async function publish(
    event: NDKEvent,
    relayUrls: string[],
    active: () => boolean,
  ) {
    const targets = relayUrls.map(getRelay);
    const results = await Promise.allSettled(
      targets.map(async (relay) => {
        if (!active()) return false;
        publishing.set(relay, (publishing.get(relay) ?? 0) + 1);
        try {
          if (!connected(relay)) await connect(relay);
          if (!active()) return false;
          return await relay.publish(event, timeout);
        } finally {
          const remaining = (publishing.get(relay) ?? 1) - 1;
          if (remaining > 0) publishing.set(relay, remaining);
          else {
            publishing.delete(relay);
            if (!configured.has(relay.url)) disconnect(relay);
          }
        }
      }),
    );
    return results.some(
      (result) => result.status === "fulfilled" && result.value,
    );
  }

  async function advertise(
    relay: NDKRelay,
    inbox: string[],
    active: () => boolean,
  ) {
    const event = new NDKEvent(undefined, {
      kind: inboxListKind,
      created_at: Math.floor(Date.now() / 1_000),
      tags: inbox.map((url) => ["relay", url]),
    });
    await event.sign(signer);
    return active() && connected(relay) && relay.publish(event, timeout);
  }

  function closePeerRelays() {
    for (const cancel of discoveryRequests) cancel();
    for (const relay of known.values()) {
      if (!configured.has(relay.url)) disconnect(relay);
    }
  }

  return {
    addConfigured,
    unconfigure,
    connect,
    connected,
    watchInbox,
    findInbox,
    wrap: (rumor: Rumor, recipient: string) =>
      wrapRumor(ndk, rumor, recipient, signer),
    publish,
    advertise,
    closePeerRelays,
  };
}
