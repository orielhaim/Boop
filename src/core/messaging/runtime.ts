import {
  locationTag,
  locationText,
  sharedLocation,
  type SharedLocation,
} from "./location";
import { BlossomError } from "../media/blossom";
import { parseServerOrigins, serverListKind } from "../media/servers";
import {
  fileMessageKind,
  fileTags,
  type AttachmentMetadata,
} from "../media/protocol";
import type { AttachmentMedia } from "../media/service";
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

import {
  createTimeLockOpener,
  encryptTimeLock,
  maxTimeLockEnvelope,
  maxTimeLockPayload,
  timeLockKind,
} from "./special-messages/timelock";
import { createUnlockScheduler } from "./special-messages/unlock-scheduler";

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
type SendInput = {
  location?: SharedLocation;
  peerKey: string;
  body: string;
  replyTo: string | null;
  unlockAt?: number;
};
const retryDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const offlineProbeDelay = 60_000;

export function createMessagingService({
  signer,
  chat,
  readState,
  writeState,
  createId,
  privacy,
  media,
}: {
  signer: NDKSigner;
  chat: MessagingRepository;
  readState: (key: string) => string | null;
  writeState: (key: string, value: string) => void;
  createId: () => string;
  media?: AttachmentMedia;
  privacy?: Pick<
    import("@/core/privacy").Privacy,
    "isBlocked" | "canReceiveCall" | "messagePermission" | "queue"
  >;
}) {
  const publicKey = signer.userSync.pubkey;
  const beaconKey = "chat.timelock.quicknet.beacons";
  function storedBeacons(): unknown[] {
    const value = readState(beaconKey);
    if (!value || value.length > 16_384) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.slice(-32) : [];
    } catch {
      return [];
    }
  }

  const unlocks = createUnlockScheduler(
    chat,
    createTimeLockOpener({
      read: (round) =>
        storedBeacons().find(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "round" in value &&
            value.round === round,
        ),
      store(beacon) {
        const retained = storedBeacons().filter(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "round" in value &&
            value.round !== beacon.round,
        );
        writeState(beaconKey, JSON.stringify([...retained, beacon].slice(-32)));
      },
    }),
  );
  let unlockActive = false;
  let unlockAllowed = false;
  let unlockGeneration = 0;
  const chatsEnabledKey = "chat.enabled";
  let chatsEnabled = readState(chatsEnabledKey) !== "false";
  let chatGeneration = 0;

  function setUnlockActive(active: boolean) {
    unlockAllowed = active;
    updateUnlocks();
  }

  function updateUnlocks() {
    const active = unlockAllowed && chatsEnabled;
    if (active === unlockActive) return;
    unlockActive = active;
    unlockGeneration++;
    unlocks.setActive(active);
    media?.setActive(active);
    if (active) void flush();
  }
  const transport = createMessagingRelays(signer);
  const listeners = new Set<() => void>();
  const callListeners = new Set<(signal: CallSignal) => void>();
  const replyRoutes = new Map<
    string,
    { expiresAt: number; relays: string[] }
  >();
  let requestCatchup: (() => void) | undefined;
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
      refreshInbox: () => void;
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
  let flushRequested = false;
  const ingestion = createInboxIngestion(
    (wrapped) =>
      unwrapPrivateEvent(wrapped, signer, privacy?.isBlocked, !chatsEnabled),
    (event) => {
      if (privacy?.isBlocked(event.peerKey)) return;
      if (event.type !== "call" && !chatsEnabled) return;
      if (event.type === "call") {
        if (event.recipientKey !== publicKey) return;
        const { signal, replyRelays } = event;
        if (
          signal.type === "call.invite" &&
          privacy &&
          (!privacy.canReceiveCall(signal.senderKey) ||
            signal.conference?.roster.some(privacy.isBlocked))
        )
          return;
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
        if (
          event.senderKey !== publicKey &&
          privacy &&
          privacy.messagePermission(event.peerKey) !== "allow"
        )
          return;
        chat.receiveReaction({
          peerKey: event.peerKey,
          eventId: event.id,
          author: event.senderKey,
          emoji: event.emoji,
          targetEventId: event.targetEventId,
        });
      } else {
        const input = {
          id: event.id,
          eventId: event.id,
          peerKey: event.peerKey,
          senderKey: event.senderKey,
          recipientKey: event.recipientKey,
          sentAt: event.sentAt,
          body:
            event.type === "message"
              ? event.body
              : event.type === "attachment"
                ? (event.file.caption ?? "")
                : event.type === "location"
                  ? locationText(event.location)
                  : "",
          location: event.type === "location" ? (true as const) : undefined,
          attachment: event.type === "attachment" ? event.file : undefined,
          timeLock: event.type === "timelock" ? event.special : undefined,
          replyTo: event.replyTo,
          direction:
            event.senderKey === publicKey
              ? ("outgoing" as const)
              : ("incoming" as const),
        };
        const policy =
          input.direction === "incoming"
            ? privacy?.messagePermission(event.peerKey)
            : "allow";
        if (policy === "request") privacy?.queue(input);
        else if (policy === undefined || policy === "allow")
          chat.receive(input);
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

  function getHistoryReady() {
    return (
      Boolean(connectionKey) &&
      chatsEnabled &&
      inboxSync === "idle" &&
      (!configuration.inbox.length || [...syncing.values()].includes("synced"))
    );
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
    requestCatchup?.();
    setUnlockActive(false);
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
    const historyWasReady = getHistoryReady();
    connectionKey = key;
    configuration = next;
    publicationRetries = 0;
    revision++;
    reportInbox("idle");
    syncConnections();
    schedulePublication();
    if (historyWasReady !== getHistoryReady())
      for (const listener of listeners) listener();
  }

  function connectRelay(relay: NDKRelay, session: number, inbox: boolean) {
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let syncTimeout: ReturnType<typeof setTimeout> | undefined;
    let closeWatch: (() => void) | undefined;
    let watch = 0;
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
      if (!active() || !inbox || !transport.connected(relay)) return;
      closeWatch?.();
      clearTimeout(syncTimeout);
      const token = ++watch;
      const syncingChats = chatsEnabled;
      const current = () => active() && token === watch;
      const catchup = syncingChats
        ? inboxCatchup(
            Math.floor(Date.now() / 1_000),
            readState(syncKey),
            readState(`chat.sync.${relay.url}`),
          )
        : undefined;
      const started = Date.now();
      let receiveSucceeded = true;
      let storedComplete = false;
      reportSync(relay.url, syncingChats ? "syncing" : undefined);
      if (syncingChats)
        syncTimeout = setTimeout(() => reportSync(relay.url, "failed"), 20_000);
      closeWatch = transport.watchInbox(
        relay,
        catchup?.since,
        (id, wrapped) => {
          if (!current() || (!syncingChats && !storedComplete)) return;
          ingestion.receive(
            id,
            wrapped,
            current,
            () => {
              receiveSucceeded = false;
            },
            storedComplete,
          );
        },
        () => {
          storedComplete = true;
          if (!catchup) return;
          void ingestion
            .drained()
            .then(() => {
              if (!active() || token !== watch) return;
              clearTimeout(syncTimeout);
              if (!receiveSucceeded) {
                reportSync(relay.url, "failed");
                return;
              }
              writeState(syncKey, catchup.checkpoint);
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
        syncingChats ? undefined : 0,
      );
    }

    function onConnect() {
      if (!active()) return;
      if (retryTimer) clearTimeout(retryTimer);
      attempts = 0;
      if (inbox) watchInbox();
      report(relay.url, { status: "connected", lastConnected: Date.now() });
      const wasOnline = status === "online";
      updateStatus("online");
      if (!wasOnline) unlocks.reconnect();
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
      refreshInbox: watchInbox,
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

  async function publishRumor(
    rumor: Rumor,
    peerKey: string,
    active: () => boolean,
  ) {
    const live = () => active() && !privacy?.isBlocked(peerKey);
    if (privacy?.isBlocked(peerKey)) return "blocked";
    const relays = await transport.findInbox(peerKey, discoveryRelays(), live);
    if (!active() || connectedRelays().length === 0) return "interrupted";
    if (relays.length === 0) return "no-inbox";
    const envelope = await transport.wrap(rumor, peerKey);
    if (privacy?.isBlocked(peerKey)) return "blocked";
    if (!active()) return "interrupted";
    if (rumor.kind === timeLockKind) {
      const envelopeBytes = JSON.stringify(envelope.rawEvent()).length;
      if (envelopeBytes > maxTimeLockEnvelope) return "relay-rejected";
      messagingMetric("timelock gift wrap", { envelopeBytes });
    }
    if (!(await transport.publish(envelope, relays, live))) {
      return !active() || connectedRelays().length === 0
        ? "interrupted"
        : "relay-rejected";
    }
    return "accepted";
  }

  async function sendCall(signal: CallSignal, active: () => boolean) {
    const session = generation;
    const live = () =>
      active() &&
      session === generation &&
      Date.now() < signal.expiresAt &&
      !privacy?.isBlocked(signal.recipientKey);
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

  async function storeSenderCopy(rumor: Rumor, active: () => boolean) {
    try {
      if (!active()) return false;
      const copy = await transport.wrap(rumor, publicKey);
      if (!active()) return false;
      const inbox = publication?.urls ?? configuration.inbox.slice(0, 3);
      return await transport.publish(copy, inbox, active);
    } catch {
      return false;
    }
  }

  async function flush() {
    if (!chatsEnabled || !connectedRelays().length) return;
    if (running) {
      flushRequested = true;
      return;
    }
    running = true;
    const session = generation;
    const chatSession = chatGeneration;
    const active = () =>
      session === generation && chatSession === chatGeneration;
    let interrupted = false;
    try {
      for (const item of unlockActive ? chat.pendingAttachmentCopies() : []) {
        if (!active() || !unlockActive) break;
        if (!item.rumorJson || privacy?.isBlocked(item.peerKey)) continue;
        const copy = parseRumor(JSON.parse(item.rumorJson));
        if (
          copy?.pubkey === publicKey &&
          copy.id === item.eventId &&
          (await storeSenderCopy(
            copy,
            () =>
              active() &&
              unlockActive &&
              !privacy?.isBlocked(item.peerKey) &&
              Boolean(chat.message(item.peerKey, item.id)),
          ))
        )
          chat.finishAttachmentCopy(item.id);
      }
      while (active() && connectedRelays().length && !interrupted) {
        const pending = chat.pending(16, unlockActive);
        if (!pending.length) break;
        for (const message of pending) {
          if (!active() || !connectedRelays().length) break;
          if (!chat.message(message.peerKey, message.id)) continue;
          try {
            const isFile = message.contentType === "attachment";
            if (isFile && !unlockActive) continue;
            const live = () =>
              active() &&
              (!isFile || unlockActive) &&
              !privacy?.isBlocked(message.peerKey) &&
              Boolean(chat.message(message.peerKey, message.id));
            let rumor = message.rumorJson
              ? parseRumor(JSON.parse(message.rumorJson))
              : null;
            let expectedId = message.eventId;
            if (isFile && !expectedId && media) {
              const record = chat.attachment(message.peerKey, message.id);
              if (!record || !live()) {
                chat.setStatus(message.id, "failed", "blocked");
                continue;
              }
              let url: string;
              try {
                url = await media.upload(message.peerKey, message.id, live);
              } catch (error) {
                if (live()) {
                  chat.setStatus(
                    message.id,
                    "failed",
                    error instanceof BlossomError
                      ? `media-${error.code}`
                      : "media-upload",
                  );
                }
                if (!unlockActive || !active()) interrupted = true;
                if (interrupted) break;
                continue;
              }
              if (!live()) {
                if (!active() || !unlockActive) {
                  interrupted = true;
                  break;
                }
                continue;
              }
              const tags = [
                ["p", message.peerKey],
                ...fileTags({ ...record.file, url }),
              ];
              if (message.replyTo)
                tags.push(["e", message.replyTo, "", "reply"]);
              rumor = createRumor({
                kind: fileMessageKind,
                pubkey: publicKey,
                content: url,
                tags,
                created_at: Math.floor(message.sentAt / 1_000),
              });
              if (
                !chat.finalizeAttachment(
                  message.peerKey,
                  message.id,
                  rumor.id,
                  url,
                  JSON.stringify(rumor),
                )
              )
                continue;
              expectedId = rumor.id;
            }
            if (
              !rumor ||
              rumor.pubkey !== publicKey ||
              rumor.id !== expectedId
            ) {
              chat.setStatus(message.id, "failed", "invalid-message");
              continue;
            }
            const result = await publishRumor(
              rumor,
              message.peerKey,
              isFile ? live : active,
            );
            if (result === "interrupted") {
              if (
                isFile &&
                active() &&
                unlockActive &&
                connectedRelays().length &&
                !live()
              ) {
                if (privacy?.isBlocked(message.peerKey))
                  chat.setStatus(message.id, "failed", "blocked");
                continue;
              }
              interrupted = true;
              break;
            }
            if (result === "accepted") {
              chat.setStatus(message.id, "sent");
              if (
                (await storeSenderCopy(rumor, isFile ? live : active)) &&
                isFile
              )
                chat.finishAttachmentCopy(message.id);
            } else if (active()) {
              chat.setStatus(message.id, "failed", result);
            }
          } catch {
            if (active())
              chat.setStatus(message.id, "failed", "relay-rejected");
          }
        }
      }
    } catch {
      // A persistence failure leaves rows pending for the next flush.
    } finally {
      running = false;
      if (!active() || flushRequested) {
        flushRequested = false;
        void flush();
      }
    }
  }

  async function send({
    peerKey,
    body,
    replyTo,
    unlockAt,
    location,
  }: SendInput) {
    if (!chatsEnabled) throw new Error("chats-disabled");
    if (privacy?.isBlocked(peerKey)) throw new Error("blocked");
    if (!publicKeySchema.safeParse(peerKey).success || peerKey === publicKey)
      throw new Error("invalid-recipient");
    if (location) {
      if (
        !unlockActive ||
        unlockAt !== undefined ||
        !sharedLocation.safeParse(location).success
      )
        throw new Error("invalid-message");
      body = locationText(location);
    }
    if (!body.trim() || body.length > maxMessageLength)
      throw new Error("invalid-message");
    const id = createId();
    const created_at = Math.floor(Date.now() / 1_000);
    const tags = [
      ["p", peerKey],
      ["salt", id],
    ];
    if (location) tags.push([locationTag, "1"]);
    if (replyTo) {
      const quoted = chat.message(peerKey, replyTo);
      if (!quoted?.eventId || quoted.deletedAt)
        throw new Error("unavailable-reply");
      tags.push(["e", quoted.eventId]);
    }
    const session = generation;
    const unlockSession = unlockGeneration;
    let special: Awaited<ReturnType<typeof encryptTimeLock>> | undefined;
    if (unlockAt !== undefined) {
      const active = () =>
        unlockActive &&
        session === generation &&
        unlockSession === unlockGeneration;
      // Let the composer paint its busy state before the pairing operation.
      await new Promise((resolve) => setTimeout(resolve, 16));
      if (!active()) throw new Error("unlock-time");
      const started = performance.now();
      special = await encryptTimeLock(body, unlockAt);
      messagingMetric("timelock encrypt", {
        ms: performance.now() - started,
        cipherBytes: special.ciphertext.length,
      });
      if (!active() || special.requestedAt <= Date.now())
        throw new Error("unlock-time");
    }
    if (special && replyTo && !chat.message(peerKey, replyTo))
      throw new Error("unavailable-reply");
    const content = special ? JSON.stringify(special) : body;
    if (special && content.length > maxTimeLockPayload)
      throw new Error("invalid-message");
    const rumor = createRumor({
      kind: special ? timeLockKind : messageKind,
      pubkey: publicKey,
      content,
      tags,
      created_at,
    });
    const writeStarted = performance.now();
    if (privacy?.isBlocked(peerKey)) throw new Error("blocked");
    const enqueued = chat.enqueue({
      id,
      eventId: rumor.id,
      peerKey,
      senderKey: publicKey,
      recipientKey: peerKey,
      direction: "outgoing",
      body: special ? "" : body,
      location: location ? true : undefined,
      timeLock: special,
      sentAt: created_at * 1_000,
      replyTo,
      rumorJson: JSON.stringify(rumor),
    });
    if (!enqueued) throw new Error("invalid-message");
    if (special)
      messagingMetric("timelock enqueued", {
        writeMs: performance.now() - writeStarted,
        contentBytes: content.length,
      });
    if (status === "offline" && configured.length) startAgain();
    void flush();
    return id;
  }

  async function sendAttachment({
    peerKey,
    uri,
    metadata,
    replyTo,
  }: {
    peerKey: string;
    uri: string;
    metadata: AttachmentMetadata;
    replyTo: string | null;
  }) {
    if (!media) throw new Error("media-unavailable");
    const id = createId();
    const sentAt = Math.floor(Date.now() / 1_000) * 1_000;
    await media.stageAttachment(uri, metadata, (attachment) => {
      if (
        !chatsEnabled ||
        !unlockActive ||
        privacy?.isBlocked(peerKey) ||
        !publicKeySchema.safeParse(peerKey).success ||
        peerKey === publicKey
      )
        throw new Error("media-unavailable");
      const quoted = replyTo ? chat.message(peerKey, replyTo) : undefined;
      if (replyTo && !quoted?.eventId) throw new Error("unavailable-reply");
      if (
        !chat.enqueue({
          id,
          peerKey,
          eventId: null,
          sentAt,
          attachment,
          replyTo: quoted?.eventId ?? null,
          senderKey: publicKey,
          recipientKey: peerKey,
          direction: "outgoing",
          body: attachment.caption ?? "",
        })
      )
        throw new Error("media-storage");
    });
    if (status === "offline" && configured.length) startAgain();
    void flush();
    return id;
  }

  function cancelAttachment(peerKey: string, id: string) {
    const record = chat.attachment(peerKey, id);
    if (!record || !["pending", "failed"].includes(record.status)) return;
    chat.deleteMessages(peerKey, [id]);
    media?.cancelUpload(id, record.file.hash);
  }

  function retry(peerKey: string, id: string) {
    if (!chatsEnabled) return;
    if (privacy?.isBlocked(peerKey)) return;
    const message = chat.message(peerKey, id);
    if (
      message?.status !== "failed" ||
      (!message.rumorJson && message.contentType !== "attachment") ||
      message.deletedAt
    )
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

  function catchupRequest(peerKey: string) {
    if (!chatsEnabled) return;
    requestCatchup?.();
    const session = generation;
    const chatSession = chatGeneration;
    const live = () =>
      session === generation &&
      chatSession === chatGeneration &&
      !privacy?.isBlocked(peerKey);
    const inboxes = [...connections.values()]
      .filter(({ relay, inbox }) => inbox && transport.connected(relay))
      .slice(0, 3);
    if (!inboxes.length || !live()) return;
    const close: (() => void)[] = [];
    function stopCatchup() {
      clearTimeout(timer);
      for (const dispose of close) dispose();
      if (requestCatchup === stopCatchup) requestCatchup = undefined;
    }
    const timer = setTimeout(stopCatchup, 5_000);
    requestCatchup = stopCatchup;
    const since = Math.floor(Date.now() / 1_000) - 3 * 86_400;
    for (const { relay } of inboxes) {
      let remaining = 96;
      close.push(
        transport.watchInbox(
          relay,
          since,
          (id, event) => {
            if (remaining-- <= 0 || !live()) return;
            ingestion.receive(
              id,
              event,
              live,
              () => undefined,
              false,
              (opened) =>
                opened.senderKey === peerKey && opened.type !== "call",
            );
          },
          () => undefined,
          96,
        ),
      );
    }
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
    if (!chatsEnabled) return;
    if (privacy?.isBlocked(peerKey)) return;
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
        [
          "k",
          String(
            message.contentType === "attachment"
              ? fileMessageKind
              : message.contentType === "timelock"
                ? timeLockKind
                : messageKind,
          ),
        ],
      ],
    });
    const session = generation;
    const chatSession = chatGeneration;
    const activeSession = () =>
      session === generation && chatSession === chatGeneration;
    void publishRumor(rumor, peerKey, activeSession)
      .then((result) => {
        if (result === "accepted") return storeSenderCopy(rumor, activeSession);
      })
      .catch(() => undefined);
  }

  let lastMediaList = 0;
  const listRelays = () => {
    const targets = new Set([
      ...configuration.general,
      ...configuration.discovery,
    ]);
    return configured
      .filter((relay) => targets.has(relay.url) && transport.connected(relay))
      .slice(0, 8);
  };
  async function readMediaList() {
    return transport.lookupLists(publicKey, listRelays(), [serverListKind]);
  }

  return {
    getChatsEnabled: () => chatsEnabled,
    setChatsEnabled(enabled: boolean) {
      if (enabled === chatsEnabled) return;
      writeState(chatsEnabledKey, String(enabled));
      chatsEnabled = enabled;
      chatGeneration++;
      requestCatchup?.();
      updateUnlocks();
      for (const connection of connections.values()) connection.refreshInbox();
      if (enabled) void flush();
      for (const listener of listeners) listener();
    },
    start,
    stop,
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
      const relays = discoveryRelays().slice(0, 4);
      return relays.length
        ? transport.watchProfiles(relays, authors, onEvent, onEose)
        : null;
    },
    async discoverBlossomServers() {
      const { general, complete } = await readMediaList();
      if (!complete && !general) throw new Error("media-list-unavailable");
      return parseServerOrigins(general?.tags ?? []);
    },
    async publishBlossomServers(origins: string[]) {
      const session = generation;
      const active = () => session === generation && unlockAllowed;
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
        configuration.general,
        active,
      );
      return Boolean(event);
    },
    publishProfile(content: string, createdAt: number) {
      const session = generation;
      return transport.publishReplaceable(
        0,
        content,
        [],
        createdAt,
        configuration.general,
        () => session === generation,
      );
    },
    reconnect: startAgain,
    catchupRequest,
    setUnlockActive,
    invalidateBlockedPeer() {
      if (!unlockActive) return;
      setUnlockActive(false);
      setUnlockActive(true);
    },
    getRelayStates: () => snapshot,
    getInboxStatus: () => publicationStatus,
    getInboxSync: () => inboxSync,
    getHistoryReady,
    send,
    sendAttachment,
    cancelAttachment,
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
