import type { NDKRelay, NDKSigner } from "@nostr-dev-kit/ndk";
import {
  type CallHandoff,
  type RelayConfiguration,
  relayRoutes,
  sameRelays,
} from "./config";
import { createNostrRelays } from "./relays-transport";

const handoffMs = 3 * 24 * 60 * 60 * 1000;

export function createRelayService(
  signer: NDKSigner,
  initialHandoff: CallHandoff = [],
  saveHandoff: (rows: CallHandoff) => void = () => undefined,
) {
  const transport = createNostrRelays(signer);
  const listeners = new Set<() => void>();
  const connections = new Map<string, { relay: NDKRelay; close(): void }>();
  const handoff = new Map(initialHandoff);
  let retiredHosts: readonly string[] | undefined;
  let configuration: RelayConfiguration = {
    general: [],
    write: [],
    inbox: [],
    discovery: [],
  };
  let enabled = false;
  const prepared = new Set<string>();
  let receiveCalls = true;
  let generation = 0;
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: Readonly<
    Record<string, "connected" | "connecting" | "offline">
  > = {};

  function publish() {
    snapshot = Object.fromEntries(
      [...connections].map(([url, { relay }]) => [
        url,
        transport.status(relay),
      ]),
    );
    for (const listener of listeners) listener();
  }

  function reconcile() {
    clearTimeout(handoffTimer);
    if (!enabled || !retiredHosts) return;
    const now = Date.now();
    let pruned = false;
    for (const [url, expiry] of handoff) {
      if (expiry <= now || !transport.permitted(url))
        pruned = handoff.delete(url) || pruned;
    }
    if (pruned) saveHandoff([...handoff]);
    const inbox = new Set([
      ...prepared,
      ...(receiveCalls ? [...configuration.inbox, ...handoff.keys()] : []),
    ]);
    const wanted = new Set(
      [...relayRoutes(configuration), ...inbox].filter(transport.permitted),
    );
    for (const [url, connection] of connections) {
      if (wanted.has(url)) continue;
      connections.delete(url);
      connection.close();
    }
    for (const url of wanted) {
      const relay = transport.addConfigured(url, inbox.has(url));
      if (connections.has(url)) continue;
      for (const event of [
        "connect",
        "disconnect",
        "delayed-connect",
        "auth",
        "authed",
      ] as const)
        relay.on(event, publish);
      connections.set(url, {
        relay,
        close() {
          for (const event of [
            "connect",
            "disconnect",
            "delayed-connect",
            "auth",
            "authed",
          ] as const)
            relay.off(event, publish);
          transport.unconfigure(relay);
        },
      });
      transport.connectConfigured(relay);
    }
    const expiry = Math.min(...handoff.values());
    if (Number.isFinite(expiry))
      handoffTimer = setTimeout(reconcile, expiry - now);
    publish();
  }

  function rememberHandoff(previous: readonly string[]) {
    const until = Date.now() + handoffMs;
    for (const url of previous)
      if (transport.permitted(url)) handoff.set(url, until);
    while (handoff.size > 12) {
      const oldest = handoff.keys().next();
      if (oldest.done) break;
      handoff.delete(oldest.value);
    }
    if (previous.length) saveHandoff([...handoff]);
  }

  const connectedRelays = () =>
    [...connections.values()]
      .map(({ relay }) => relay)
      .filter(transport.connected);

  return {
    transport,
    async prepareInbox(
      urls: readonly string[],
      previous: readonly string[],
      active: () => boolean,
    ) {
      for (const url of urls) prepared.add(url);
      reconcile();
      function release() {
        for (const url of urls) prepared.delete(url);
        reconcile();
      }
      try {
        const checks = await Promise.all(
          urls.map((url) => transport.verifyInboxUrl(url, active)),
        );
        if (active() && checks.every(Boolean)) {
          rememberHandoff(previous);
          return release;
        }
        release();
        return null;
      } catch (error) {
        release();
        throw error;
      }
    },
    configure(
      next: RelayConfiguration,
      allowCalls: boolean,
      blockedHosts: readonly string[],
    ) {
      const samePolicy = retiredHosts && sameRelays(retiredHosts, blockedHosts);
      retiredHosts = blockedHosts;
      transport.setRetiredHosts(blockedHosts);
      if (
        samePolicy &&
        allowCalls === receiveCalls &&
        sameRelays(configuration.inbox, next.inbox) &&
        sameRelays(configuration.general, next.general) &&
        sameRelays(configuration.write, next.write) &&
        sameRelays(configuration.discovery, next.discovery)
      )
        return;
      let pruned = false;
      for (const url of next.inbox) pruned = handoff.delete(url) || pruned;
      if (pruned) saveHandoff([...handoff]);
      rememberHandoff(
        configuration.inbox.filter((url) => !next.inbox.includes(url)),
      );
      configuration = next;
      receiveCalls = allowCalls;
      reconcile();
    },
    start() {
      if (enabled) return;
      enabled = true;
      reconcile();
    },
    stop() {
      if (!enabled) return;
      enabled = false;
      generation++;
      prepared.clear();
      clearTimeout(handoffTimer);
      for (const connection of connections.values()) connection.close();
      connections.clear();
      transport.closePeerRelays();
      publish();
    },
    reconnect(url?: string) {
      for (const [address, { relay }] of connections)
        if (!url || url === address) transport.reconnectConfigured(relay);
      publish();
    },
    connectedRelays,
    discoveryRelays: connectedRelays,
    inboxRelays: () =>
      receiveCalls
        ? connectedRelays().filter(
            ({ url }) =>
              configuration.inbox.includes(url) ||
              handoff.has(url) ||
              prepared.has(url),
          )
        : [],
    replyRelays: () =>
      receiveCalls
        ? connectedRelays().filter(({ url }) =>
            configuration.inbox.includes(url),
          )
        : [],
    configuration: () => configuration,
    generation: () => generation,
    getStatus: () =>
      connectedRelays().length ? "online" : enabled ? "offline" : "disabled",
    getRelayStates: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type RelayService = ReturnType<typeof createRelayService>;
