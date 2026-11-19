import type { NDKRelay, NDKSigner } from "@nostr-dev-kit/ndk";
import type { MessagingRepository } from "@/db/messaging";
import { type CallSignal, callSignalKind } from "../calling/signals";
import { publicKeySchema } from "../identity/keys";
import {
  type InboxPublication,
  inboxHandoffMs,
  inboxPublicationKey,
  type RelayConfiguration,
  readPublication,
  sameRelays,
} from "../nostr/config";
import { createMessagingRelays } from "../nostr/messaging-relays";
import { messagingMetric } from "./diagnostics";
import { createInboxIngestion, inboxCatchup } from "./inbox-sync";
import {
  callReplyRelayTag,
  createRumor,
  inboxListKind,
  maxMessageLength,
  messageKind,
  parseReaction,
  parseRumor,
  type Rumor,
  reactionKind,
  unwrapPrivateEvent,
} from "./nip17";

export type MessagingStatus = "disabled" | "connecting" | "online" | "offline";
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
type SendInput = { peerKey: string; body: string; replyTo: string | null };
const retryDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const offlineProbeDelay = 60_000;

export function createMessagingService({
  signer,
  chat,
  readState,
  writeState,
  createId,
}: {
  signer: NDKSigner;
  chat: MessagingRepository;
  readState: (key: string) => string | null;
  writeState: (key: string, value: string) => void;
  createId: () => string;
}) {
  const publicKey = signer.userSync.pubkey;
  const transport = createMessagingRelays(signer);
  const listeners = new Set<() => void>();
  const callListeners = new Set<(signal: CallSignal) => void>();
  const replyRoutes = new Map<
    string,
    { expiresAt: number; relays: string[] }
  >();
  let status: MessagingStatus = "disabled";
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
  const syncing = new Map<string, "syncing" | "synced" | "failed">();
  let inboxSync: "idle" | "syncing" | "failed" = "idle";
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
  let running = false;
  const ingestion = createInboxIngestion(
    (wrapped) => unwrapPrivateEvent(wrapped, signer),
    (event) => {
      if (event.type === "call") {
        if (event.recipientKey !== publicKey) return;
        const { signal, replyRelays } = event;
        if (
          (signal.type === "call.invite" || signal.type === "call.rtc") &&
          replyRelays.length
        ) {
          const key = `${signal.callId}:${signal.senderKey}`;
          if (!replyRoutes.has(key) && replyRoutes.size >= 32) {
            const oldest = replyRoutes.keys().next().value;
            if (oldest !== undefined) replyRoutes.delete(oldest);
          }
          replyRoutes.set(key, {
            expiresAt: signal.expiresAt,
            relays: replyRelays,
          });
        }
        for (const listener of callListeners) listener(signal);
      } else if (event.type === "reaction") {
        chat.receiveReaction({
          peerKey: event.peerKey,
          eventId: event.id,
          author: event.senderKey,
          emoji: event.emoji,
          targetEventId: event.targetEventId,
        });
      } else {
        chat.receive({
          id: event.id,
          eventId: event.id,
          peerKey: event.peerKey,
          senderKey: event.senderKey,
          recipientKey: event.recipientKey,
          sentAt: event.sentAt,
          body: event.body,
          replyTo: event.replyTo,
          direction: event.senderKey === publicKey ? "outgoing" : "incoming",
        });
      }
    },
  );

  function updateStatus(next: MessagingStatus) {
    if (next === status) return;
    status = next;
    for (const listener of listeners) listener();
  }

  function reportSync(url: string, phase?: "syncing" | "synced" | "failed") {
    if (phase) syncing.set(url, phase);
    else syncing.delete(url);
    const states = [...syncing.values()];
    const next = states.includes("syncing")
      ? "syncing"
      : states.length && states.every((value) => value === "failed")
        ? "failed"
        : "idle";
    if (next === inboxSync) return;
    inboxSync = next;
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
        ...connectRelay(relay, generation, inbox),
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
    replyRoutes.clear();
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

  function connectRelay(relay: NDKRelay, session: number, inbox: boolean) {
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let syncTimeout: ReturnType<typeof setTimeout> | undefined;
    let closeWatch: (() => void) | undefined;
    let watch = 0;
    let catchup: ReturnType<typeof inboxCatchup> | undefined;
    let live = true;
    const active = () => live && session === generation;
    const syncKey = `chat.sync.v2.${publicKey}.${relay.url}`;

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

    function watchInbox() {
      if (!active() || !inbox || !catchup) return;
      closeWatch?.();
      clearTimeout(syncTimeout);
      const token = ++watch;
      const { since, checkpoint } = catchup;
      const started = Date.now();
      let receiveSucceeded = true;
      let storedComplete = false;
      reportSync(relay.url, "syncing");
      syncTimeout = setTimeout(() => reportSync(relay.url, "failed"), 20_000);
      closeWatch = transport.watchInbox(
        relay,
        since,
        (id, wrapped) => {
          if (token !== watch || !active()) return;
          ingestion.receive(
            id,
            wrapped,
            active,
            () => {
              receiveSucceeded = false;
            },
            storedComplete,
          );
        },
        () => {
          storedComplete = true;
          void ingestion
            .drained()
            .then(() => {
              if (!active() || token !== watch) return;
              clearTimeout(syncTimeout);
              if (!receiveSucceeded) {
                reportSync(relay.url, "failed");
                return;
              }
              writeState(syncKey, checkpoint);
              reportSync(relay.url, "synced");
              messagingMetric("catch-up", {
                ms: Date.now() - started,
                queued: ingestion.queued(),
              });
            })
            .catch(() => {
              if (active() && token === watch) reportSync(relay.url, "failed");
            });
        },
      );
    }

    function onConnect() {
      if (!active()) return;
      if (retryTimer) clearTimeout(retryTimer);
      attempts = 0;
      if (inbox) {
        catchup = inboxCatchup(
          Math.floor(Date.now() / 1_000),
          readState(syncKey),
          readState(`chat.sync.${relay.url}`),
        );
        watchInbox();
      }
      report(relay.url, { status: "connected", lastConnected: Date.now() });
      updateStatus("online");
      schedulePublication();
      // Retry discovered/queued sends only when a relay is actually reachable.
      void flush();
    }

    function onDisconnect() {
      if (!active()) return;
      watch++;
      clearTimeout(syncTimeout);
      reportSync(relay.url);
      report(relay.url, { status: "disconnected" });
      closeWatch?.();
      closeWatch = undefined;
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
      watchInbox();
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
        else if (syncing.get(relay.url) === "failed") watchInbox();
      },
      close() {
        live = false;
        if (retryTimer) clearTimeout(retryTimer);
        clearTimeout(syncTimeout);
        reportSync(relay.url);
        closeWatch?.();
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

  async function publishRumor(rumor: Rumor, peerKey: string, session: number) {
    const relays = await transport.findInbox(
      peerKey,
      discoveryRelays(),
      () => session === generation,
    );
    if (session !== generation || connectedRelays().length === 0)
      return "interrupted";
    if (relays.length === 0) return "no-inbox";
    const envelope = await transport.wrap(rumor, peerKey);
    if (session !== generation) return "interrupted";
    if (
      !(await transport.publish(envelope, relays, () => session === generation))
    ) {
      return connectedRelays().length === 0 ? "interrupted" : "relay-rejected";
    }
    return "accepted";
  }

  async function sendCall(signal: CallSignal, active: () => boolean) {
    const session = generation;
    const live = () =>
      active() && session === generation && Date.now() < signal.expiresAt;
    if (!live() || connectedRelays().length === 0) return false;
    const replyRoute = replyRoutes.get(
      `${signal.callId}:${signal.recipientKey}`,
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
      const listening = [...connections.values()]
        .filter(({ relay, inbox }) => inbox && transport.connected(relay))
        .map(({ relay }) => relay.url);
      for (const url of listening.slice(0, 3))
        tags.push([callReplyRelayTag, url]);
    }
    const rumor = createRumor({
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
      messagingMetric("call reply via invitation", {
        ms: performance.now() - started,
        accepted,
        answer: signal.type === "call.accept",
      });
      if (accepted) return true;
    }
    if (!live()) return false;
    const urls = await transport.findCallInbox(
      signal.callId,
      signal.recipientKey,
      discoveryRelays(),
    );
    if (!urls.length) return false;
    return live() && transport.publish(envelope, urls, live);
  }

  async function storeSenderCopy(rumor: Rumor, session: number) {
    try {
      const copy = await transport.wrap(rumor, publicKey);
      if (session !== generation) return;
      const inbox = publication?.urls ?? configuration.inbox.slice(0, 3);
      await transport.publish(copy, inbox, () => session === generation);
    } catch {
      // Acceptance on the recipient's inbox remains valid if our copy fails.
    }
  }

  async function flush() {
    if (running || !connectedRelays().length) return;
    running = true;
    const session = generation;
    let interrupted = false;
    try {
      while (
        session === generation &&
        connectedRelays().length &&
        !interrupted
      ) {
        const pending = chat.pending(16);
        if (!pending.length) break;
        for (const message of pending) {
          if (session !== generation || !connectedRelays().length) break;
          if (!chat.message(message.peerKey, message.id)) continue;
          try {
            const rumor = message.rumorJson
              ? parseRumor(JSON.parse(message.rumorJson))
              : null;
            if (
              !rumor ||
              rumor.pubkey !== publicKey ||
              rumor.id !== message.eventId
            ) {
              chat.setStatus(message.id, "failed", "invalid-message");
              continue;
            }
            const result = await publishRumor(rumor, message.peerKey, session);
            if (result === "interrupted") {
              interrupted = true;
              break;
            }
            if (result === "accepted") {
              chat.setStatus(message.id, "sent");
              await storeSenderCopy(rumor, session);
            } else if (session === generation) {
              chat.setStatus(message.id, "failed", result);
            }
          } catch {
            if (session === generation)
              chat.setStatus(message.id, "failed", "relay-rejected");
          }
        }
      }
    } catch {
      // A persistence failure leaves rows pending for the next flush.
    } finally {
      running = false;
      if (session !== generation && connectedRelays().length) void flush();
    }
  }

  async function send({ peerKey, body, replyTo }: SendInput) {
    if (!publicKeySchema.safeParse(peerKey).success || peerKey === publicKey)
      throw new Error("invalid-recipient");
    if (!body.trim() || body.length > maxMessageLength)
      throw new Error("invalid-message");
    const id = createId();
    const created_at = Math.floor(Date.now() / 1_000);
    const tags = [
      ["p", peerKey],
      ["salt", id],
    ];
    if (replyTo) {
      const quoted = chat.message(peerKey, replyTo);
      if (!quoted?.eventId || quoted.deletedAt)
        throw new Error("unavailable-reply");
      tags.push(["e", quoted.eventId]);
    }
    const rumor = createRumor({
      kind: messageKind,
      pubkey: publicKey,
      content: body,
      tags,
      created_at,
    });
    chat.enqueue({
      id,
      eventId: rumor.id,
      peerKey,
      senderKey: publicKey,
      recipientKey: peerKey,
      direction: "outgoing",
      body,
      sentAt: created_at * 1_000,
      replyTo,
      rumorJson: JSON.stringify(rumor),
    });
    if (status === "offline" && configured.length) startAgain();
    void flush();
    return id;
  }

  function retry(peerKey: string, id: string) {
    const message = chat.message(peerKey, id);
    if (message?.status !== "failed" || !message.rumorJson || message.deletedAt)
      return;
    chat.setStatus(message.id, "pending");
    if (!connectedRelays().length && configured.length) startAgain();
    void flush();
  }

  function startAgain() {
    publicationRetries = 0;
    for (const connection of connections.values()) connection.reconnect();
    schedulePublication();
  }

  function toggleReaction({
    peerKey,
    messageId,
    emoji,
  }: {
    peerKey: string;
    messageId: string;
    emoji: string;
  }) {
    const reaction = parseReaction(emoji);
    if (!reaction) return;
    const message = chat.message(peerKey, messageId);
    if (!message || message.deletedAt) return;
    const active = chat.toggleReaction(
      peerKey,
      message.id,
      publicKey,
      reaction,
    );
    if (!active || !message.eventId || !connectedRelays().length) return;
    const rumor = createRumor({
      kind: reactionKind,
      pubkey: publicKey,
      content: reaction,
      created_at: Math.floor(Date.now() / 1_000),
      tags: [
        ["p", peerKey],
        ["e", message.eventId],
        ["k", String(messageKind)],
      ],
    });
    const session = generation;
    void publishRumor(rumor, peerKey, session)
      .then((result) => {
        if (result === "accepted") return storeSenderCopy(rumor, session);
      })
      .catch(() => undefined);
  }

  return {
    start,
    stop,
    reconnect: startAgain,
    getRelayStates: () => snapshot,
    getInboxStatus: () => publicationStatus,
    getInboxSync: () => inboxSync,
    send,
    retry,
    toggleReaction,
    sendCall,
    prepareCallRoute: (callId: string, recipient: string) =>
      transport.findCallInbox(callId, recipient, discoveryRelays()),
    subscribeCalls: (listener: (signal: CallSignal) => void) => {
      callListeners.add(listener);
      return () => {
        callListeners.delete(listener);
      };
    },
    getStatus: () => status,
    subscribeStatus: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
