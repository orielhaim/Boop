import type { NDKRelay, NDKSigner } from "@nostr-dev-kit/ndk";
import {
  type InboxPublication,
  inboxHandoffMs,
  inboxPublicationKey,
  type RelayConfiguration,
  readPublication,
  sameRelays,
} from "./config";
import { inboxListKind } from "./gift-wrap";
import { createNostrRelays } from "./relays-transport";

export type RelayStatus = "disabled" | "connecting" | "online" | "offline";
export type RelayState = {
  status:
    | "connected"
    | "connecting"
    | "disconnected"
    | "auth-required"
    | "rejected"
    | "unavailable";
  lastConnected?: number;
  inboxVerified?: boolean;
  lastWrite?: "accepted" | "rejected";
};
export type InboxStatus =
  "idle" | "validating" | "published" | "conflict" | "unverified" | "pending";
const retryDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const offlineProbeDelay = 60_000;

export function createRelayService({
  signer,
  readState,
  writeState,
}: {
  signer: NDKSigner;
  readState: (key: string) => string | null;
  writeState: (key: string, value: string) => void;
}) {
  const publicKey = signer.userSync.pubkey;
  const transport = createNostrRelays(signer);
  const listeners = new Set<() => void>();
  let status: RelayStatus = "disabled";
  let generation = 0;
  let configured: NDKRelay[] = [];
  let connectionKey = "";
  let configuration: RelayConfiguration = {
    general: [],
    inbox: [],
    discovery: [],
    intent: null,
  };
  const connections = new Map<
    string,
    {
      relay: NDKRelay;
      inbox: boolean;
      close: () => void;
      reconnect: () => void;
    }
  >();
  const diagnostics = new Map<string, RelayState>();
  let snapshot: Readonly<Record<string, RelayState>> = {};
  let publication = readPublication(readState(inboxPublicationKey));
  let publicationStatus: InboxStatus = "idle";
  let publishingList = false;
  let publicationRetries = 0;
  let needsPublication = false;
  let revision = 0;
  let publicationTimer: ReturnType<typeof setTimeout> | undefined;
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
  const verified = new Set<string>();
  const previousTargets = new Set<string>();
  function updateStatus(next: RelayStatus) {
    if (next === status) return;
    status = next;
    for (const listener of listeners) listener();
  }

  function connectedRelays() {
    return configured.filter(transport.connected);
  }

  function discoveryRelays() {
    const urls = new Set([
      ...configuration.general,
      ...configuration.discovery,
    ]);
    return connectedRelays().filter(
      (relay) => urls.has(relay.url) || connections.get(relay.url)?.inbox,
    );
  }

  function report(url: string, patch: Partial<RelayState>) {
    diagnostics.set(url, {
      status: "disconnected",
      ...diagnostics.get(url),
      ...patch,
    });
    snapshot = Object.fromEntries(diagnostics);
    for (const listener of listeners) listener();
  }

  function reportInbox(next: InboxStatus) {
    if (next === publicationStatus) return;
    publicationStatus = next;
    for (const listener of listeners) listener();
  }

  function syncConnections() {
    const inbox = new Set(configuration.inbox);
    if (inbox.size) {
      for (const url of publication?.urls ?? []) inbox.add(url);
      for (const url of previousTargets) inbox.add(url);
      for (const item of publication?.previous ?? [])
        if (item.until > Date.now()) inbox.add(item.url);
    }
    const wanted = new Set([
      ...configuration.general,
      ...configuration.discovery,
      ...inbox,
    ]);
    for (const [url, connection] of connections) {
      if (wanted.has(url) && connection.inbox === inbox.has(url)) continue;
      connection.close();
      connections.delete(url);
      if (!wanted.has(url)) report(url, { status: "disconnected" });
    }
    const added: { relay: NDKRelay; inbox: boolean }[] = [];
    for (const url of wanted) {
      if (!connections.has(url))
        added.push({
          relay: transport.addConfigured(url, inbox.has(url)),
          inbox: inbox.has(url),
        });
    }
    configured = [...connections.values()]
      .map(({ relay }) => relay)
      .concat(added.map(({ relay }) => relay));
    for (const { relay, inbox } of added) {
      connections.set(relay.url, {
        relay,
        inbox,
        ...connectRelay(relay, generation),
      });
    }
    if (!configured.length) updateStatus("disabled");
    else if (!connectedRelays().length) updateStatus("connecting");
    if (handoffTimer) clearTimeout(handoffTimer);
    const nextExpiry = Math.min(
      ...(publication?.previous ?? [])
        .map(({ until }) => until)
        .filter((until) => until > Date.now()),
    );
    if (Number.isFinite(nextExpiry))
      handoffTimer = setTimeout(syncConnections, nextExpiry - Date.now() + 1);
  }

  function schedulePublication(delay = 350) {
    if (publicationTimer) clearTimeout(publicationTimer);
    publicationTimer = setTimeout(() => void publishInbox(), delay);
  }

  async function publishInbox() {
    if (publishingList) {
      needsPublication = true;
      return;
    }
    if (!configuration.inbox.length) return;
    if (!discoveryRelays().length) {
      if (configuration.intent) reportInbox("pending");
      return;
    }
    const expected = revision;
    const active = () => expected === revision;
    const { inbox, intent } = configuration;
    if (inbox.length > 3) {
      reportInbox("unverified");
      return;
    }
    const discovery = [
      ...new Set([
        ...discoveryRelays(),
        ...connectedRelays().filter((relay) => inbox.includes(relay.url)),
      ]),
    ];
    publishingList = true;
    try {
      const { inbox: remote, complete } = await transport.lookupLists(
        publicKey,
        discovery,
        [inboxListKind],
      );
      if (!active()) return;
      const remoteUrls = remote
        ? transport.safeTargets(remote.tags, "inbox")
        : [];
      const confirmed = remote && sameRelays(inbox, remoteUrls);
      const explicit =
        intent && intent !== "initial" && intent !== publication?.intent;
      const externalChange =
        remote &&
        !confirmed &&
        (!publication || remote.created_at >= publication.eventTime);
      if (externalChange) {
        previousTargets.clear();
        for (const url of remoteUrls) previousTargets.add(url);
        syncConnections();
      }
      if (externalChange && !explicit) {
        reportInbox("conflict");
        return;
      }
      if (!confirmed && !intent) {
        reportInbox("idle");
        return;
      }
      if (!confirmed && !complete) {
        reportInbox("pending");
        return;
      }
      if (
        confirmed &&
        publication &&
        sameRelays(publication.urls, inbox) &&
        publication.eventTime === remote.created_at &&
        publication.intent === intent
      ) {
        reportInbox("published");
        return;
      }
      const candidates = connectedRelays().filter((relay) =>
        inbox.includes(relay.url),
      );
      if (candidates.length !== inbox.length) {
        reportInbox("pending");
        return;
      }
      reportInbox("validating");
      const checks = await Promise.all(
        candidates.map(async (relay) => {
          if (verified.has(relay.url)) return true;
          const pass = await transport
            .verifyInbox(relay, active)
            .catch(() => false);
          if (active()) {
            if (pass) verified.add(relay.url);
            report(relay.url, { inboxVerified: pass });
          }
          return pass;
        }),
      );
      if (!active()) return;
      if (!checks.every(Boolean)) {
        reportInbox("unverified");
        return;
      }
      const eventTime = confirmed
        ? remote.created_at
        : Math.max(
            Math.floor(Date.now() / 1_000),
            (remote?.created_at ?? 0) + 1,
            (publication?.eventTime ?? 0) + 1,
          );
      if (!confirmed) {
        const accepted = await transport.advertise(
          discovery,
          inbox,
          eventTime,
          active,
        );
        if (!active()) return;
        const published = accepted
          ? (await transport.lookupLists(publicKey, discovery, [inboxListKind]))
              .inbox
          : null;
        if (!active()) return;
        if (
          !published ||
          !sameRelays(inbox, transport.safeTargets(published.tags, "inbox")) ||
          published.created_at < eventTime
        ) {
          reportInbox("pending");
          return;
        }
      }
      const until = Date.now() + inboxHandoffMs;
      const previous = new Map(
        (publication?.previous ?? [])
          .filter((item) => item.until > Date.now())
          .map((item) => [item.url, item]),
      );
      for (const url of [...(publication?.urls ?? []), ...previousTargets]) {
        if (!inbox.includes(url)) previous.set(url, { url, until });
      }
      const next: InboxPublication = {
        urls: [...inbox],
        eventTime,
        intent,
        previous: [...previous.values()]
          .filter((item) => !inbox.includes(item.url))
          .slice(-12),
      };
      writeState(inboxPublicationKey, JSON.stringify(next));
      publication = next;
      previousTargets.clear();
      reportInbox("published");
      syncConnections();
    } catch {
      if (active()) reportInbox("pending");
    } finally {
      publishingList = false;
      if (needsPublication) {
        needsPublication = false;
        schedulePublication();
      } else if (
        active() &&
        (publicationStatus === "pending" ||
          publicationStatus === "unverified") &&
        publicationRetries < 2
      ) {
        schedulePublication(5_000 * ++publicationRetries);
      }
    }
  }

  function stop() {
    generation++;
    revision++;
    if (publicationTimer) clearTimeout(publicationTimer);
    if (handoffTimer) clearTimeout(handoffTimer);
    needsPublication = false;
    for (const connection of connections.values()) connection.close();
    connections.clear();
    configured = [];
    connectionKey = "";
    transport.closePeerRelays();
    for (const url of diagnostics.keys())
      report(url, { status: "disconnected" });
    updateStatus("disabled");
  }

  function start(next: RelayConfiguration) {
    const key = JSON.stringify(next);
    if (connectionKey === key) return;
    connectionKey = key;
    configuration = next;
    publicationRetries = 0;
    revision++;
    reportInbox("idle");
    syncConnections();
    schedulePublication();
  }

  function connectRelay(relay: NDKRelay, session: number) {
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const active = () => live && session === generation;

    function attemptConnection() {
      if (!active() || transport.connected(relay)) return;
      clearTimeout(retryTimer);
      const burstDelay = retryDelays[attempts];
      if (burstDelay !== undefined) attempts++;
      const delay = burstDelay ?? offlineProbeDelay;
      report(relay.url, {
        status: burstDelay === undefined ? "unavailable" : "connecting",
      });
      retryTimer = setTimeout(() => {
        if (!active() || transport.connected(relay)) return;
        updateStatus(connectedRelays().length ? "online" : "offline");
        // A connection can remain stuck in CONNECTING after a failed handshake.
        // Close it before giving the next scheduled attempt a fresh socket.
        if (delay >= 8_000) {
          relay.connectivity.resetReconnectionState();
          relay.disconnect();
        }
        attemptConnection();
      }, delay);
      void transport.connect(relay);
    }

    function onConnect() {
      if (!active()) return;
      if (retryTimer) clearTimeout(retryTimer);
      attempts = 0;
      report(relay.url, { status: "connected", lastConnected: Date.now() });
      updateStatus("online");
      schedulePublication();
    }

    function onDisconnect() {
      if (!active()) return;
      report(relay.url, { status: "disconnected" });
      if (retryTimer) clearTimeout(retryTimer);
      relay.connectivity.resetReconnectionState();
      updateStatus(connectedRelays().length ? "online" : "offline");
      retryTimer = setTimeout(
        attemptConnection,
        retryDelays[attempts] ?? offlineProbeDelay,
      );
    }

    const onAuth = () => report(relay.url, { status: "auth-required" });
    const onAuthed = () => {
      report(relay.url, { status: "connected" });
      schedulePublication();
    };
    const onRejected = () => report(relay.url, { status: "rejected" });
    const onWrite = () => report(relay.url, { lastWrite: "accepted" });
    const onWriteFailed = () => report(relay.url, { lastWrite: "rejected" });
    relay.on("connect", onConnect);
    relay.on("disconnect", onDisconnect);
    relay.on("auth", onAuth);
    relay.on("authed", onAuthed);
    relay.on("auth:failed", onRejected);
    relay.on("published", onWrite);
    relay.on("publish:failed", onWriteFailed);
    if (transport.connected(relay)) onConnect();
    else attemptConnection();
    return {
      reconnect() {
        attempts = 0;
        if (retryTimer) clearTimeout(retryTimer);
        if (!transport.connected(relay)) attemptConnection();
      },
      close() {
        live = false;
        if (retryTimer) clearTimeout(retryTimer);
        relay.off("connect", onConnect);
        relay.off("disconnect", onDisconnect);
        relay.off("auth", onAuth);
        relay.off("authed", onAuthed);
        relay.off("auth:failed", onRejected);
        relay.off("published", onWrite);
        relay.off("publish:failed", onWriteFailed);
        transport.unconfigure(relay);
      },
    };
  }

  function reconnect() {
    publicationRetries = 0;
    for (const connection of connections.values()) connection.reconnect();
    schedulePublication();
  }

  return {
    transport,
    start,
    stop,
    reconnect,
    connectedRelays,
    discoveryRelays,
    inboxRelays: () =>
      [...connections.values()]
        .filter(({ relay, inbox }) => inbox && transport.connected(relay))
        .map(({ relay }) => relay),
    configuration: () => configuration,
    generation: () => generation,
    senderCopyRelays: () =>
      publication?.urls ?? configuration.inbox.slice(0, 3),
    getStatus: () => status,
    getRelayStates: () => snapshot,
    getInboxStatus: () => publicationStatus,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type RelayService = ReturnType<typeof createRelayService>;
