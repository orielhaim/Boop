import type { NDKRelay, NDKSigner } from "@nostr-dev-kit/ndk";
import type { MessagingRepository } from "@/db/messaging";
import { type CallSignal, callSignalKind } from "../calling/signals";
import { publicKeySchema } from "../identity/keys";
import { createMessagingRelays } from "../nostr/messaging-relays";
import { secureRelays } from "../nostr/relays";
import {
  createRumor,
  maxMessageLength,
  messageKind,
  parseReaction,
  parseRumor,
  type Rumor,
  reactionKind,
  unwrapPrivateEvent,
} from "./nip17";

export type MessagingStatus = "disabled" | "connecting" | "online" | "offline";
type SendInput = { peerKey: string; body: string; replyTo: string | null };
const retryDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const catchupOverlap = 3 * 24 * 60 * 60;

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
  let status: MessagingStatus = "disabled";
  let generation = 0;
  let configured: NDKRelay[] = [];
  let connectionKey = "";
  let cleanups: (() => void)[] = [];
  let running = false;

  function updateStatus(next: MessagingStatus) {
    if (next === status) return;
    status = next;
    for (const listener of listeners) listener();
  }

  function connectedRelays() {
    return configured.filter(transport.connected);
  }

  function stop() {
    generation++;
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    configured = [];
    connectionKey = "";
    transport.closePeerRelays();
    updateStatus("disabled");
  }

  function start(urls: readonly string[]) {
    const next = secureRelays(urls).sort();
    const key = JSON.stringify(next);
    if (connectionKey === key) return;
    stop();
    connectionKey = key;
    if (next.length === 0) return;
    const session = generation;
    configured = next.map(transport.addConfigured);
    updateStatus("connecting");
    cleanups = configured.map((relay) => connectInbox(relay, session));
  }

  function connectInbox(relay: NDKRelay, session: number) {
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let closeWatch: (() => void) | undefined;
    let receive = Promise.resolve();
    let inboxWriteSucceeded = false;
    let advertising = false;
    const syncKey = `chat.sync.${relay.url}`;
    const advertisementKey = `chat.inbox.${relay.url}`;

    function attemptConnection() {
      if (session !== generation || transport.connected(relay)) return;
      if (attempts >= retryDelays.length) return;
      const delay = retryDelays[attempts++];
      retryTimer = setTimeout(() => {
        if (session !== generation || transport.connected(relay)) return;
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

    async function advertiseInbox() {
      if (advertising || inboxWriteSucceeded || session !== generation) return;
      advertising = true;
      const inbox = configured.map((item) => item.url).slice(0, 3);
      const value = JSON.stringify(inbox);
      try {
        if (
          readState(advertisementKey) === value ||
          (await transport.advertise(
            relay,
            inbox,
            () => session === generation,
          ))
        ) {
          if (session !== generation) return;
          writeState(advertisementKey, value);
          inboxWriteSucceeded = true;
        }
      } catch {
        // Read access can still work. The next connection can retry the listing.
      } finally {
        advertising = false;
      }
    }

    function onConnect() {
      if (session !== generation) return;
      if (retryTimer) clearTimeout(retryTimer);
      attempts = 0;
      closeWatch?.();
      let receiveSucceeded = true;
      const beganAt = Math.floor(Date.now() / 1_000);
      const previousSync = Number(readState(syncKey) ?? 0);
      const since =
        previousSync > 0 && previousSync <= beganAt
          ? Math.max(0, previousSync - catchupOverlap)
          : undefined;
      closeWatch = transport.watchInbox(
        relay,
        since,
        (wrapped) => {
          receive = receive
            .then(async () => {
              if (session !== generation) return;
              const event = await unwrapPrivateEvent(wrapped, signer);
              if (!event || session !== generation) return;
              if (event.type === "call") {
                if (event.recipientKey === publicKey)
                  for (const listener of callListeners) listener(event.signal);
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
                  direction:
                    event.senderKey === publicKey ? "outgoing" : "incoming",
                });
              }
            })
            .catch(() => {
              receiveSucceeded = false;
            });
        },
        () => {
          void receive
            .then(() => {
              if (session === generation && receiveSucceeded)
                writeState(syncKey, String(beganAt));
            })
            .catch(() => undefined);
        },
      );
      updateStatus("online");
      void advertiseInbox();
      // Retry discovered/queued sends only when a relay is actually reachable.
      void flush();
    }

    function onDisconnect() {
      if (session !== generation) return;
      closeWatch?.();
      closeWatch = undefined;
      if (retryTimer) clearTimeout(retryTimer);
      relay.connectivity.resetReconnectionState();
      updateStatus(connectedRelays().length ? "online" : "offline");
      retryTimer = setTimeout(
        attemptConnection,
        retryDelays[Math.min(attempts, retryDelays.length - 1)],
      );
    }

    relay.on("connect", onConnect);
    relay.on("disconnect", onDisconnect);
    relay.on("authed", advertiseInbox);
    if (transport.connected(relay)) onConnect();
    else attemptConnection();
    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      closeWatch?.();
      relay.off("connect", onConnect);
      relay.off("disconnect", onDisconnect);
      relay.off("authed", advertiseInbox);
      transport.unconfigure(relay);
    };
  }

  async function publishRumor(rumor: Rumor, peerKey: string, session: number) {
    const relays = await transport.findInbox(peerKey, connectedRelays());
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
    const urls = await transport.findInbox(
      signal.recipientKey,
      connectedRelays(),
    );
    if (!live() || !urls.length) return false;
    const rumor = createRumor({
      kind: callSignalKind,
      pubkey: publicKey,
      content: JSON.stringify(signal),
      tags: [["p", signal.recipientKey]],
      created_at: signal.createdAt / 1_000,
    });
    const envelope = await transport.wrap(rumor, signal.recipientKey);
    return live() && transport.publish(envelope, urls, live);
  }

  async function storeSenderCopy(rumor: Rumor, session: number) {
    try {
      const copy = await transport.wrap(rumor, publicKey);
      if (session !== generation) return;
      const inbox = configured.map((relay) => relay.url).slice(0, 3);
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
    const urls = configured.map((relay) => relay.url);
    connectionKey = "";
    start(urls);
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
    send,
    retry,
    toggleReaction,
    sendCall,
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
