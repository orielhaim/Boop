import NDK, {
  type NDKAuthPolicy,
  NDKEvent,
  type NDKFilter,
  NDKRelay,
  NDKRelaySet,
  NDKRelayStatus,
  type NDKSigner,
} from "@nostr-dev-kit/ndk";
import { inviteLifetime } from "../calling/signals";
import {
  createRumor,
  giftWrapKind,
  inboxListKind,
  messageKind,
  type Rumor,
  verifiedEvent,
  wrapRumor,
} from "../messaging/nip17";
import { isPublicRelayAddress, secureRelays } from "./relays";

const timeout = 7_000;
const connected = (relay: NDKRelay) => relay.status >= NDKRelayStatus.CONNECTED;

export function createMessagingRelays(signer: NDKSigner) {
  const ndk = new NDK({
    signer,
    enableOutboxModel: false,
    autoConnectUserRelays: false,
  });
  const configured = new Set<string>();
  const authenticate = new Set<string>();
  const known = new Map<string, NDKRelay>();
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
    authenticate.has(relay.url) ? true : undefined;

  function getRelay(url: string) {
    let relay = ndk.pool.relays.get(url) ?? known.get(url);
    if (!relay) {
      relay = new NDKRelay(url, auth, ndk);
      known.set(url, relay);
    }
    return relay;
  }

  function disconnect(relay: NDKRelay) {
    connecting.get(relay)?.cancel();
    relay.connectivity.resetReconnectionState();
    relay.disconnect();
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
    void relay.connect(timeout, false).catch(cancel);
    return result;
  }

  function addConfigured(url: string, inbox: boolean) {
    const relay = getRelay(url);
    if (!configured.has(relay.url)) callInboxes.clear();
    configured.add(relay.url);
    if (inbox) authenticate.add(relay.url);
    ndk.explicitRelayUrls ??= [];
    if (!ndk.explicitRelayUrls.includes(relay.url))
      ndk.explicitRelayUrls.push(relay.url);
    ndk.pool.addRelay(relay, false);
    return relay;
  }

  function unconfigure(relay: NDKRelay) {
    callInboxes.clear();
    configured.delete(relay.url);
    authenticate.delete(relay.url);
    disconnect(relay);
    // NDK 3.0.3 leaves its connect listeners attached after removeRelay.
    // Keep the reusable relay registered. Boop controls its connection and
    // passes an explicit set of enabled relays to each subscription.
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
    onEvent: (id: string, event: unknown) => void,
    onEose: () => void,
  ) {
    return subscription(
      [relay],
      { kinds: [giftWrapKind], "#p": [signer.userSync.pubkey], since },
      (event) => onEvent(event.id, event.rawEvent()),
      onEose,
    );
  }

  function lookupLists(
    peerKey: string,
    discovery: NDKRelay[],
    kinds: number[] = [inboxListKind, 10002],
  ) {
    type ListEvent = NonNullable<ReturnType<typeof verifiedEvent>>;
    const empty: {
      inbox: ListEvent | null;
      general: ListEvent | null;
      complete: boolean;
    } = { inbox: null, general: null, complete: false };
    if (discovery.length === 0) return Promise.resolve(empty);
    return new Promise<{
      inbox: ListEvent | null;
      general: ListEvent | null;
      complete: boolean;
    }>((resolve) => {
      let inbox: ListEvent | null = null;
      let general: ListEvent | null = null;
      let stop: (() => void) | undefined;
      const deadline = setTimeout(() => finish(false), timeout);
      function cancel() {
        finish(false, true);
      }
      function finish(complete: boolean, cancelled = false) {
        if (!discoveryRequests.delete(cancel)) return;
        clearTimeout(deadline);
        stop?.();
        resolve(cancelled ? empty : { inbox, general, complete });
      }
      discoveryRequests.add(cancel);
      stop = subscription(
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
            return;
          const latest = candidate.kind === inboxListKind ? inbox : general;
          if (newer(candidate, latest)) {
            if (candidate.kind === inboxListKind) inbox = candidate;
            else general = candidate;
          }
        },
        () => finish(true),
        true,
      );
    });
  }

  function newer(
    candidate: NonNullable<ReturnType<typeof verifiedEvent>>,
    latest: ReturnType<typeof verifiedEvent>,
  ) {
    return (
      !latest ||
      candidate.created_at > latest.created_at ||
      (candidate.created_at === latest.created_at && candidate.id < latest.id)
    );
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
      .filter((url) => configured.has(url) || isPublicRelayAddress(url))
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
            disconnect(relay);
            known.delete(relay.url);
          }
        }
      }
    }
  }

  async function publish(
    event: NDKEvent,
    relayUrls: string[],
    active: () => boolean,
  ) {
    const targets = relayUrls.map(getRelay);
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
  async function advertise(
    relays: NDKRelay[],
    inbox: readonly string[],
    createdAt: number,
    active: () => boolean,
  ) {
    const event = new NDKEvent(undefined, {
      kind: inboxListKind,
      created_at: createdAt,
      tags: inbox.map((url) => ["relay", url]),
    });
    await event.sign(signer);
    if (!active()) return false;
    const results = await Promise.allSettled(
      relays.map((relay) => connected(relay) && relay.publish(event, timeout)),
    );
    return results.some(
      (result) => result.status === "fulfilled" && result.value,
    );
  }

  async function verifyInbox(relay: NDKRelay, active: () => boolean) {
    if (!active() || !connected(relay)) return false;
    const publicKey = signer.userSync.pubkey;
    const probe = createRumor({
      // A self-addressed empty rumor never becomes a Boop conversation.
      kind: messageKind,
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
    return new Promise<boolean>((resolve) => {
      let stop: (() => void) | undefined;
      const deadline = setTimeout(() => finish(false), timeout);
      function cancel() {
        finish(false);
      }
      function finish(valid: boolean) {
        if (!discoveryRequests.delete(cancel)) return;
        clearTimeout(deadline);
        stop?.();
        resolve(valid);
      }
      discoveryRequests.add(cancel);
      stop = subscription(
        [relay],
        { kinds: [giftWrapKind], ids: [envelope.id], "#p": [publicKey] },
        (event) =>
          finish(
            active() && verifiedEvent(event.rawEvent())?.id === envelope.id,
          ),
        () => finish(false),
        true,
      );
    });
  }

  function closePeerRelays() {
    callInboxes.clear();
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
    findCallInbox,
    lookupLists,
    safeTargets,
    verifyInbox,
    wrap: (rumor: Rumor, recipient: string) =>
      wrapRumor(ndk, rumor, recipient, signer),
    publish,
    advertise,
    closePeerRelays,
  };
}
