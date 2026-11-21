import type { NDKRelay, NDKSigner } from "@nostr-dev-kit/ndk";
import { unsignedRumor, unwrapRumor } from "../nostr/gift-wrap";
import type { RelayService } from "../nostr/relay-service";
import { callMetric } from "./diagnostics";
import { type CallSignal, callSignalKind, parseCallSignal } from "./signals";

export const callReplyRelayTag = "boop:reply-relay";

export async function unwrapCallSignal(
  input: unknown,
  signer: NDKSigner,
  isBlocked?: (key: string) => boolean,
) {
  const opened = await unwrapRumor(input, signer, isBlocked);
  const rumor = opened?.rumor;
  const recipientKey = signer.userSync.pubkey;
  if (!rumor || rumor.kind !== callSignalKind) return null;
  const participants = new Set(
    rumor.tags.filter(([tag]) => tag === "p").map((tag) => tag[1]),
  );
  participants.add(rumor.pubkey);
  if (participants.size !== 2 || !participants.has(recipientKey)) return null;
  const signal = parseCallSignal(
    rumor.content,
    {
      senderKey: rumor.pubkey,
      recipientKey,
      sentAt: rumor.created_at * 1_000,
    },
    Date.now(),
  );
  if (!signal) return null;
  const replyRelays =
    signal.type === "call.invite" || signal.type === "call.rtc"
      ? rumor.tags
          .flatMap(([tag, url]) =>
            tag === callReplyRelayTag && url ? [url] : [],
          )
          .slice(0, 3)
      : [];
  return { id: rumor.id, signal, replyRelays };
}

export function createCallSignalingService({
  signer,
  relays,
  isBlocked,
  canReceiveCall,
}: {
  signer: NDKSigner;
  relays: RelayService;
  isBlocked: (key: string) => boolean;
  canReceiveCall: (key: string) => boolean;
}) {
  const { transport } = relays;
  const listeners = new Set<(signal: CallSignal) => void>();
  const replyRoutes = new Map<
    string,
    { expiresAt: number; relays: string[] }
  >();
  const seen = new Map<string, number>();
  const pending = new Set<string>();
  const watches = new Map<NDKRelay, () => void>();
  let disconnect: (() => void) | undefined;
  let generation = 0;
  let relayGeneration = relays.generation();

  async function receive(id: string, input: unknown, active: () => boolean) {
    if (!active() || pending.has(id) || pending.size >= 256) return;
    pending.add(id);
    try {
      const opened = await unwrapCallSignal(input, signer, isBlocked);
      if (!opened || !active()) return;
      const { signal, replyRelays } = opened;
      const now = Date.now();
      if (
        signal.expiresAt <= now ||
        isBlocked(signal.senderKey) ||
        seen.has(opened.id)
      )
        return;
      if (
        signal.type === "call.invite" &&
        (!canReceiveCall(signal.senderKey) ||
          signal.conference?.roster.some(isBlocked))
      )
        return;
      for (const [key, expiresAt] of seen)
        if (expiresAt <= now) seen.delete(key);
      if (seen.size >= 4_096) return;
      seen.set(opened.id, signal.expiresAt);
      if (replyRelays.length) {
        const key = routeKey(signal.callId, signal.senderKey);
        if (!replyRoutes.has(key) && replyRoutes.size >= 32) {
          const oldest = replyRoutes.keys().next().value;
          if (oldest !== undefined) replyRoutes.delete(oldest);
        }
        replyRoutes.set(key, {
          expiresAt: signal.expiresAt,
          relays: replyRelays,
        });
      }
      for (const listener of listeners) listener(signal);
    } finally {
      pending.delete(id);
    }
  }

  function watch(relay: NDKRelay) {
    let closeWatch: (() => void) | undefined;
    let token = 0;
    function refresh() {
      closeWatch?.();
      const expected = ++token;
      closeWatch = transport.watchInbox(
        relay,
        undefined,
        (id, input) => {
          void receive(id, input, () => token === expected).catch(
            () => undefined,
          );
        },
        () => undefined,
        0,
      );
    }
    relay.on("authed", refresh);
    refresh();
    return () => {
      token++;
      closeWatch?.();
      relay.off("authed", refresh);
    };
  }

  function syncWatches() {
    const current = relays.generation();
    if (relayGeneration !== current) {
      relayGeneration = current;
      replyRoutes.clear();
    }
    const wanted = new Set(relays.inboxRelays());
    for (const [relay, close] of watches) {
      if (wanted.has(relay)) continue;
      close();
      watches.delete(relay);
    }
    for (const relay of wanted)
      if (!watches.has(relay)) watches.set(relay, watch(relay));
  }

  function prepareRoute(callId: string, recipient: string) {
    return transport.findCallInbox(callId, recipient, relays.discoveryRelays());
  }

  async function send(signal: CallSignal, active: () => boolean) {
    const session = generation;
    const relaySession = relays.generation();
    const publicKey = signer.userSync.pubkey;
    const live = () =>
      disconnect !== undefined &&
      active() &&
      session === generation &&
      relaySession === relays.generation() &&
      Date.now() < signal.expiresAt &&
      !isBlocked(signal.recipientKey);
    if (
      !live() ||
      signal.senderKey !== publicKey ||
      !relays.connectedRelays().length
    )
      return false;
    const replyRoute = replyRoutes.get(
      routeKey(signal.callId, signal.recipientKey),
    );
    const replyTargets =
      replyRoute && replyRoute.expiresAt > Date.now()
        ? transport.safeTargets(
            replyRoute.relays.map((url) => ["relay", url]),
            "inbox",
          )
        : [];
    const tags = [["p", signal.recipientKey]];
    if (signal.type === "call.invite" || signal.type === "call.rtc") {
      for (const relay of relays.inboxRelays().slice(0, 3))
        tags.push([callReplyRelayTag, relay.url]);
    }
    const rumor = unsignedRumor({
      kind: callSignalKind,
      pubkey: publicKey,
      content: JSON.stringify(signal),
      tags,
      created_at: signal.createdAt / 1_000,
    });
    const envelope = await transport.wrap(rumor, signal.recipientKey);
    if (!live()) return false;
    if (replyTargets.length) {
      const started = performance.now();
      const accepted = await transport.publish(envelope, replyTargets, live);
      callMetric("call reply via invitation", {
        ms: performance.now() - started,
        accepted,
        answer: signal.type === "call.accept",
      });
      if (accepted) return true;
    }
    if (!live()) return false;
    const urls = await prepareRoute(signal.callId, signal.recipientKey);
    return live() && urls.length > 0 && transport.publish(envelope, urls, live);
  }

  return {
    start() {
      if (disconnect) return;
      disconnect = relays.subscribe(syncWatches);
      syncWatches();
    },
    stop() {
      generation++;
      disconnect?.();
      disconnect = undefined;
      for (const close of watches.values()) close();
      watches.clear();
      replyRoutes.clear();
    },
    send,
    prepareRoute,
    subscribe(listener: (signal: CallSignal) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function routeKey(callId: string, recipient: string) {
  return `${callId}:${recipient}`;
}
