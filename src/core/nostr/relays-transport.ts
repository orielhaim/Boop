import NDK, {
  type NDKAuthPolicy,
  NDKEvent,
  type NDKFilter,
  NDKRelay,
  NDKRelaySet,
  NDKRelayStatus,
  type NDKSigner,
} from "@nostr-dev-kit/ndk";
import { callSignalKind, inviteLifetime } from "../calling/signals";
import { serverListKind } from "../media/servers";
import {
  unsignedRumor,
  giftWrapKind,
  inboxListKind,
  type UnsignedEvent,
  verifiedEvent,
  wrapRumor,
} from "./gift-wrap";
import { isPublicRelayAddress, secureRelays } from "./relays";

const timeout = 7_000;
const connected = (relay: NDKRelay) => relay.status >= NDKRelayStatus.CONNECTED;

export function createNostrRelays(signer: NDKSigner) {
  const ndk = new NDK({
    signer,
    enableOutboxModel: false,
    autoConnectUserRelays: false,
  });
  const configured = new Map<string, boolean>();
  let retiredHosts = new Set<string>();
  const publishing = new Map<NDKRelay, number>();
  const discoveryRequests = new Set<() => void>();
  const connecting = new Map<
    NDKRelay,
    { result: Promise<boolean>; cancel: () => void }
  >();
  const callInboxes = new Map<
    string,
    { expiresAt: number; result: Promise<string[]> }
  >();
  // NDK 3.0.3 handles a relay rejecting AUTH on its boolean policy path.
  // Its signed-event policy path leaves the same rejection unhandled.
  const auth: NDKAuthPolicy = async (relay) =>
    configured.get(relay.url) ? true : undefined;

  function getRelay(url: string) {
    let relay = ndk.pool.relays.get(url);
    if (!relay) {
      relay = new NDKRelay(url, auth, ndk);
      ndk.pool.addRelay(relay, false);
    }
    return relay;
  }

  function connect(relay: NDKRelay) {
    if (connected(relay)) return Promise.resolve(true);
    const pending = connecting.get(relay);
    if (pending) return pending.result;

    function cancel() {
      finish(false);
    }
    function opened() {
      finish(true);
    }
    function finish(ready: boolean) {
      if (!connecting.delete(relay)) return;
      clearTimeout(deadline);
      relay.off("connect", opened);
      relay.off("disconnect", cancel);
      relay.off("delayed-connect", cancel);
      resolve(ready);
    }
    let resolve: (ready: boolean) => void = () => {};
    const result = new Promise<boolean>((done) => {
      resolve = done;
    });
    const deadline = setTimeout(cancel, timeout);
    connecting.set(relay, { result, cancel });
    relay.on("connect", opened);
    relay.on("disconnect", cancel);
    relay.on("delayed-connect", cancel);
    // NDK connect resolves after creating the socket, before its open event.
    void relay.connect(timeout, configured.has(relay.url)).catch(cancel);
    return result;
  }

  function addConfigured(url: string, inbox: boolean) {
    const relay = getRelay(url);
    if (!configured.has(relay.url)) callInboxes.clear();
    configured.set(relay.url, inbox);
    return relay;
  }

  function unconfigure(relay: NDKRelay) {
    callInboxes.clear();
    configured.delete(relay.url);
    removeRelay(relay);
  }

  function removeRelay(relay: NDKRelay) {
    connecting.get(relay)?.cancel();
    relay.removeAllListeners();
    ndk.pool.removeRelay(relay.url);
  }

  function permitted(url: string) {
    try {
      return !retiredHosts.has(
        new URL(url).hostname.toLowerCase().replace(/\.$/, ""),
      );
    } catch {
      return false;
    }
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
    onEvent: (id: string, event: unknown) => void,
  ) {
    return subscription(
      [relay],
      {
        kinds: [giftWrapKind],
        "#p": [signer.userSync.pubkey],
        // Gift-wrap timestamps are randomized. Check a bounded replay window
        // after authentication or reconnect, then enforce expiry on the rumor.
        since: Math.floor(Date.now() / 1_000) - 2 * 24 * 60 * 60,
        limit: 32,
      },
      (event) => onEvent(event.id, event.rawEvent()),
      () => undefined,
    );
  }

  function query(
    relays: NDKRelay[],
    filter: NDKFilter,
    onEvent: (event: NDKEvent) => boolean,
    signal?: AbortSignal,
  ) {
    if (!relays.length || signal?.aborted) return Promise.resolve("cancelled");
    return new Promise<"complete" | "matched" | "timeout" | "cancelled">(
      (resolve) => {
        let stop: (() => void) | undefined;
        const deadline = setTimeout(() => finish("timeout"), timeout);
        function cancel() {
          finish("cancelled");
        }
        function finish(result: Parameters<typeof resolve>[0]) {
          if (!discoveryRequests.delete(cancel)) return;
          clearTimeout(deadline);
          signal?.removeEventListener("abort", cancel);
          stop?.();
          resolve(result);
        }
        discoveryRequests.add(cancel);
        signal?.addEventListener("abort", cancel, { once: true });
        stop = subscription(
          relays,
          filter,
          (event) => {
            if (discoveryRequests.has(cancel) && onEvent(event))
              finish("matched");
          },
          () => finish("complete"),
          true,
        );
      },
    );
  }

  async function lookupLists(
    peerKey: string,
    discovery: NDKRelay[],
    kinds: number[] = [inboxListKind, 10002],
  ) {
    type ListEvent = NonNullable<ReturnType<typeof verifiedEvent>>;
    const latest = new Map<number, ListEvent>();
    const outcome = await query(
      discovery,
      { kinds, authors: [peerKey], limit: 8 },
      (event) => {
        const candidate = verifiedEvent(event.rawEvent());
        if (
          !candidate ||
          !kinds.includes(candidate.kind) ||
          candidate.pubkey !== peerKey ||
          candidate.created_at > Date.now() / 1_000 + 60
        )
          return false;
        const previous = latest.get(candidate.kind);
        if (
          !previous ||
          candidate.created_at > previous.created_at ||
          (candidate.created_at === previous.created_at &&
            candidate.id < previous.id)
        )
          latest.set(candidate.kind, candidate);
        return false;
      },
    );
    if (outcome === "cancelled") latest.clear();
    return {
      inbox: latest.get(inboxListKind) ?? null,
      general:
        latest.get(kinds.find((kind) => kind !== inboxListKind) ?? 0) ?? null,
      complete: outcome === "complete",
    };
  }

  function safeTargets(tags: string[][], kind: "inbox" | "author") {
    return secureRelays(
      tags.flatMap(([tag, url, marker]) =>
        url &&
        (kind === "inbox"
          ? tag === "relay"
          : tag === "r" && (!marker || marker === "write"))
          ? [url]
          : [],
      ),
    )
      .filter(
        (url) =>
          permitted(url) && (configured.has(url) || isPublicRelayAddress(url)),
      )
      .slice(0, 3);
  }

  async function findInbox(
    peerKey: string,
    discovery: NDKRelay[],
    active: () => boolean,
  ) {
    const lists = await lookupLists(peerKey, discovery);
    if (!active()) return [];
    const indexed = lists.inbox;
    if (indexed) return safeTargets(indexed.tags, "inbox");
    const urls = lists.general ? safeTargets(lists.general.tags, "author") : [];
    const relays = urls
      .filter((url) => !discovery.some((relay) => relay.url === url))
      .map(getRelay);
    return withRelays(relays, async () => {
      await Promise.all(
        relays.map((relay) =>
          connected(relay) ? Promise.resolve() : connect(relay),
        ),
      );
      if (!active()) return [];
      const direct = await lookupLists(peerKey, relays.filter(connected), [
        inboxListKind,
      ]);
      return direct.inbox ? safeTargets(direct.inbox.tags, "inbox") : [];
    });
  }

  function findCallInbox(
    callId: string,
    peerKey: string,
    discovery: NDKRelay[],
  ) {
    const key = `${callId}:${peerKey}`;
    const now = Date.now();
    const cached = callInboxes.get(key);
    if (cached && cached.expiresAt > now) return cached.result;
    callInboxes.delete(key);
    if (callInboxes.size >= 32) {
      const oldest = callInboxes.keys().next().value;
      if (oldest !== undefined) callInboxes.delete(oldest);
    }
    const result: Promise<string[]> = findInbox(
      peerKey,
      discovery,
      () => callInboxes.get(key)?.result === result,
    )
      .catch(() => [])
      .then((urls) => {
        if (!urls.length && callInboxes.get(key)?.result === result)
          callInboxes.delete(key);
        return urls;
      });
    callInboxes.set(key, { expiresAt: now + inviteLifetime, result });
    return result;
  }

  async function withRelays<T>(
    relays: NDKRelay[],
    operation: () => Promise<T>,
  ) {
    for (const relay of relays)
      publishing.set(relay, (publishing.get(relay) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      for (const relay of relays) {
        const remaining = (publishing.get(relay) ?? 1) - 1;
        if (remaining) publishing.set(relay, remaining);
        else {
          publishing.delete(relay);
          if (!configured.has(relay.url)) {
            if (ndk.pool.relays.get(relay.url) === relay) removeRelay(relay);
          }
        }
      }
    }
  }

  async function publish(
    event: NDKEvent,
    relayUrls: readonly string[],
    active: () => boolean,
  ) {
    const targets = relayUrls.filter(permitted).map(getRelay);
    if (!targets.length) return false;
    return new Promise<boolean>((resolve) => {
      let remaining = targets.length;
      function settle(accepted: boolean) {
        remaining--;
        if (accepted || remaining === 0) resolve(accepted);
      }
      for (const relay of targets) {
        void withRelays([relay], async () => {
          if (
            !active() ||
            !(await connect(relay)) ||
            !active() ||
            !connected(relay)
          )
            return false;
          return relay.publish(event, timeout);
        }).then(settle, () => settle(false));
      }
    });
  }
  async function verifyInbox(relay: NDKRelay, active: () => boolean) {
    if (!active() || !connected(relay)) return false;
    const publicKey = signer.userSync.pubkey;
    const probe = unsignedRumor({
      // The self-addressed probe cannot pass call-signal validation.
      kind: callSignalKind,
      pubkey: publicKey,
      tags: [["p", publicKey]],
      content: "",
      created_at: Math.floor(Date.now() / 1_000),
    });
    const envelope = await wrapRumor(
      ndk,
      probe,
      publicKey,
      signer,
      probe.created_at + 120,
    );
    if (!active() || !envelope.id || !(await relay.publish(envelope, timeout)))
      return false;
    return (
      (await query(
        [relay],
        { kinds: [giftWrapKind], ids: [envelope.id], "#p": [publicKey] },
        (event) =>
          active() && verifiedEvent(event.rawEvent())?.id === envelope.id,
      )) === "matched"
    );
  }

  function closePeerRelays() {
    callInboxes.clear();
    for (const cancel of discoveryRequests) cancel();
    for (const relay of ndk.pool.relays.values()) {
      if (!configured.has(relay.url)) removeRelay(relay);
    }
  }

  return {
    addConfigured,
    unconfigure,
    connect,
    connected,
    status: (relay: NDKRelay) =>
      connected(relay)
        ? ("connected" as const)
        : relay.status === NDKRelayStatus.CONNECTING ||
            relay.status === NDKRelayStatus.RECONNECTING
          ? ("connecting" as const)
          : ("offline" as const),
    connectConfigured(relay: NDKRelay) {
      void relay.connect(timeout).catch(() => undefined);
    },
    reconnectConfigured(relay: NDKRelay) {
      if (connected(relay)) return;
      relay.connectivity.resetReconnectionState();
      void relay.connect(timeout).catch(() => undefined);
    },
    watchInbox,
    async discoverProfileKeys(
      targets: NDKRelay[],
      phrase: string,
      receive: (key: string) => void,
      signal: AbortSignal,
    ) {
      const keys = new Set<string>();
      await query(
        targets,
        { kinds: [0], search: phrase, limit: 24 },
        (raw) => {
          const event = verifiedEvent(raw.rawEvent());
          if (event?.kind !== 0 || keys.has(event.pubkey)) return false;
          keys.add(event.pubkey);
          receive(event.pubkey);
          return keys.size === 24;
        },
        signal,
      );
    },
    async publishServerList(
      tags: string[][],
      createdAt: number,
      relays: readonly string[],
      active: () => boolean,
    ) {
      const event = new NDKEvent(undefined, {
        kind: serverListKind,
        content: "",
        created_at: createdAt,
        tags,
      });
      await event.sign(signer);
      return (await publish(event, relays, active)) ? event.rawEvent() : null;
    },
    findInbox,
    findCallInbox,
    lookupLists,
    safeTargets,
    setRetiredHosts(hosts: readonly string[]) {
      retiredHosts = new Set(hosts);
    },
    permitted,
    async verifyInboxUrl(url: string, active: () => boolean) {
      const relay = ndk.pool.relays.get(url);
      return Boolean(
        relay &&
        configured.get(url) &&
        active() &&
        (await connect(relay)) &&
        (await verifyInbox(relay, active)),
      );
    },
    wrap: (rumor: UnsignedEvent, recipient: string, expiresAt?: number) =>
      wrapRumor(ndk, rumor, recipient, signer, expiresAt),
    publish,
    closePeerRelays,
  };
}
