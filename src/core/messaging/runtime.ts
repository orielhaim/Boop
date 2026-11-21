import {
  locationTag,
  locationText,
  sharedLocation,
  type SharedLocation,
} from "./location";
import { BlossomError } from "../media/blossom";
import {
  fileMessageKind,
  fileTags,
  type AttachmentMetadata,
} from "../media/protocol";
import type { AttachmentMedia } from "../media/service";
import type { NDKRelay, NDKSigner } from "@nostr-dev-kit/ndk";
import type { MessagingRepository } from "@/db/messaging";
import { publicKeySchema } from "../identity/keys";
import type { RelayService } from "../nostr/relay-service";
import { messagingMetric } from "./diagnostics";
import { createInboxIngestion, inboxCatchup } from "./inbox-sync";
import {
  createRumor,
  maxMessageLength,
  messageEditKind,
  messageEditText,
  messageKind,
  parseReaction,
  parseEditRumor,
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

export type { RelayStatus as MessagingStatus } from "../nostr/relay-service";
type SendInput = {
  location?: SharedLocation;
  peerKey: string;
  body: string;
  replyTo: string | null;
  unlockAt?: number;
};
export function createMessagingService({
  signer,
  chat,
  readState,
  writeState,
  createId,
  privacy,
  media,
  relays,
}: {
  signer: NDKSigner;
  chat: MessagingRepository;
  readState: (key: string) => string | null;
  writeState: (key: string, value: string) => void;
  createId: () => string;
  media?: AttachmentMedia;
  relays: RelayService;
  privacy?: Pick<
    import("@/core/privacy").Privacy,
    "isBlocked" | "messagePermission" | "queue"
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
  let keepBackgroundUploads = false;
  let unlockGeneration = 0;
  const chatsEnabledKey = "chat.enabled";
  let chatsEnabled = readState(chatsEnabledKey) !== "false";
  let chatGeneration = 0;

  function setUnlockActive(active: boolean, background = false) {
    unlockAllowed = active;
    keepBackgroundUploads = background;
    updateUnlocks();
  }

  function updateUnlocks() {
    const active = unlockAllowed && chatsEnabled;
    media?.setActive(active, chatsEnabled && keepBackgroundUploads);
    if (active === unlockActive) return;
    unlockActive = active;
    unlockGeneration++;
    unlocks.setActive(active);
    if (active) void flush();
  }
  const { transport, connectedRelays, discoveryRelays } = relays;
  const listeners = new Set<() => void>();
  const watchers = new Map<
    NDKRelay,
    { close: () => void; refresh: () => void }
  >();
  const syncing = new Map<string, "syncing" | "synced" | "failed">();
  let inboxSync: "idle" | "syncing" | "failed" = "idle";
  let requestCatchup: (() => void) | undefined;
  let disconnect: (() => void) | undefined;
  let generation = 0;
  let onlineRelays = new Set<NDKRelay>();
  let running = false;
  let flushRequested = false;
  const ingestion = createInboxIngestion(
    (wrapped) => unwrapPrivateEvent(wrapped, signer, privacy?.isBlocked),
    (event) => {
      if (!chatsEnabled || privacy?.isBlocked(event.peerKey)) return;
      if (event.type === "edit") {
        if (
          event.senderKey !== publicKey &&
          privacy &&
          privacy.messagePermission(event.peerKey) !== "allow"
        )
          return;
        chat.receiveEdit(event);
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
      Boolean(disconnect) &&
      chatsEnabled &&
      inboxSync === "idle" &&
      (!relays.configuration().inbox.length ||
        [...syncing.values()].includes("synced"))
    );
  }

  function syncWatches() {
    const wanted = new Set(
      chatsEnabled && disconnect ? relays.inboxRelays() : [],
    );
    for (const [relay, watcher] of watchers) {
      if (wanted.has(relay)) continue;
      watchers.delete(relay);
      watcher.close();
    }
    for (const relay of wanted)
      if (!watchers.has(relay)) watchers.set(relay, watchInbox(relay));
  }

  function start() {
    if (!disconnect) {
      disconnect = relays.subscribe(() => {
        syncWatches();
        const connected = connectedRelays();
        const added = connected.some((relay) => !onlineRelays.has(relay));
        if (added && !onlineRelays.size) unlocks.reconnect();
        onlineRelays = new Set(connected);
        if (added) void flush();
        for (const listener of listeners) listener();
      });
    }
    syncWatches();
  }

  function stop(background = false) {
    requestCatchup?.();
    setUnlockActive(false, background);
    generation++;
    disconnect?.();
    disconnect = undefined;
    onlineRelays.clear();
    syncWatches();
  }

  function watchInbox(relay: NDKRelay) {
    let closeWatch: (() => void) | undefined;
    let syncTimeout: ReturnType<typeof setTimeout> | undefined;
    let watch = 0;
    let live = true;
    const active = () => live;
    const syncKey = `chat.sync.v2.${publicKey}.${relay.url}`;
    function refresh() {
      if (!active() || !chatsEnabled || !transport.connected(relay)) return;
      closeWatch?.();
      clearTimeout(syncTimeout);
      const token = ++watch;
      const current = () => active() && token === watch;
      const catchup = inboxCatchup(
        Math.floor(Date.now() / 1_000),
        readState(syncKey),
      );
      const started = Date.now();
      let receiveSucceeded = true;
      let storedComplete = false;
      reportSync(relay.url, "syncing");
      syncTimeout = setTimeout(() => reportSync(relay.url, "failed"), 20_000);
      closeWatch = transport.watchInbox(
        relay,
        catchup.since,
        (id, wrapped) => {
          if (!current()) return;
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
      );
    }

    relay.on("authed", refresh);
    refresh();
    return {
      refresh,
      close() {
        live = false;
        clearTimeout(syncTimeout);
        closeWatch?.();
        relay.off("authed", refresh);
        reportSync(relay.url);
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

  async function storeSenderCopy(rumor: Rumor, active: () => boolean) {
    try {
      if (!active()) return false;
      const copy = await transport.wrap(rumor, publicKey);
      if (!active()) return false;
      const inbox = relays.senderCopyRelays();
      return await transport.publish(copy, inbox, active);
    } catch {
      return false;
    }
  }

  async function flushEdits(active: () => boolean) {
    for (const copies of [false, true]) {
      for (const item of chat.editOutbox(copies)) {
        if (!active() || !connectedRelays().length) return;
        const targetIsLive = () =>
          active() && Boolean(chat.message(item.peerKey, item.messageId));
        const canCopy = () =>
          targetIsLive() && !privacy?.isBlocked(item.peerKey);
        if (!targetIsLive() || (copies && !canCopy())) continue;
        try {
          const rumor = parseRumor(JSON.parse(item.rumorJson));
          const edit = rumor && parseEditRumor(rumor, publicKey);
          if (
            !rumor ||
            !edit ||
            edit.senderKey !== publicKey ||
            edit.id !== item.revisionId ||
            edit.peerKey !== item.peerKey
          ) {
            if (copies)
              chat.finishEditCopy(item.peerKey, item.revisionId, false);
            else
              chat.failEdit(item.peerKey, item.revisionId, "invalid-message");
            continue;
          }
          if (copies) {
            const success = await storeSenderCopy(rumor, canCopy);
            if (canCopy() && (success || connectedRelays().length))
              chat.finishEditCopy(item.peerKey, item.revisionId, success);
          } else {
            const result = await publishRumor(
              rumor,
              item.peerKey,
              targetIsLive,
            );
            if (!targetIsLive()) continue;
            if (result === "accepted") {
              if (!chat.finishEditDelivery(edit))
                chat.failEdit(
                  item.peerKey,
                  item.revisionId,
                  privacy?.isBlocked(item.peerKey)
                    ? "blocked"
                    : "invalid-message",
                );
            } else if (result !== "interrupted")
              chat.failEdit(item.peerKey, item.revisionId, result);
          }
        } catch {
          if (!targetIsLive()) continue;
          if (copies) chat.finishEditCopy(item.peerKey, item.revisionId, false);
          else chat.failEdit(item.peerKey, item.revisionId, "relay-rejected");
        }
      }
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
              const uploadLive = () =>
                live() &&
                chat.message(message.peerKey, message.id)?.status === "pending";
              try {
                url = await media.upload(
                  message.peerKey,
                  message.id,
                  uploadLive,
                );
              } catch (error) {
                if (uploadLive()) {
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
              if (!uploadLive()) {
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
              media.finishUpload(message.id);
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
      if (!interrupted && unlockActive) {
        const activation = unlockGeneration;
        await flushEdits(
          () => active() && unlockActive && activation === unlockGeneration,
        );
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
    if (relays.getStatus() === "offline") startAgain();
    void flush();
    return id;
  }

  function editMessage(
    peerKey: string,
    id: string,
    baseRevisionId: string,
    input: string,
  ) {
    if (!chatsEnabled || !unlockActive || privacy?.isBlocked(peerKey))
      throw new Error("edit-unavailable");
    const text = messageEditText.safeParse(input);
    if (!text.success) throw new Error("invalid-message");
    const target = chat.message(peerKey, id);
    if (
      !target?.eventId ||
      target.direction !== "outgoing" ||
      target.senderKey !== publicKey ||
      target.recipientKey !== peerKey ||
      target.contentType !== "text"
    )
      throw new Error("edit-unavailable");
    const parent = target.revisionId ?? target.eventId;
    if (target.body.trim() === text.data) return;
    if (parent !== baseRevisionId) throw new Error("edit-conflict");
    const rumor = createRumor({
      kind: messageEditKind,
      pubkey: publicKey,
      created_at: Math.floor(
        Math.max(Date.now(), target.editedAt ?? target.sentAt) / 1_000,
      ),
      tags: [
        ["p", peerKey],
        ["e", target.eventId],
      ],
      content: JSON.stringify({
        v: 1,
        targetId: target.eventId,
        previousRevisionId: parent,
        text: text.data,
      }),
    });
    const edit = parseEditRumor(rumor, publicKey);
    if (!edit || !chat.enqueueEdit(target.id, edit, JSON.stringify(rumor)))
      throw new Error("edit-unavailable");
    if (relays.getStatus() === "offline") startAgain();
    void flush();
  }

  function retryEdit(peerKey: string, id: string) {
    if (!chatsEnabled || !unlockActive || privacy?.isBlocked(peerKey))
      throw new Error("edit-unavailable");
    chat.retryEdit(peerKey, id);
    if (relays.getStatus() === "offline") startAgain();
    void flush();
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
    if (relays.getStatus() === "offline") startAgain();
    void flush();
    return id;
  }

  function cancelAttachment(peerKey: string, id: string) {
    const record = chat.attachment(peerKey, id);
    if (!record || !["pending", "failed"].includes(record.status)) return;
    chat.deleteMessages(peerKey, [id]);
    media?.cancelUpload(id, record.file.hash);
  }

  function pauseAttachment(peerKey: string, id: string) {
    const record = chat.attachment(peerKey, id);
    if (
      !unlockActive ||
      record?.status !== "pending" ||
      record.url ||
      !media?.canPauseUpload(id)
    )
      return;
    chat.setStatus(id, "failed", "media-paused");
    media.pauseUpload(id);
  }

  function retry(peerKey: string, id: string) {
    if (!chatsEnabled) return;
    if (
      privacy?.isBlocked(peerKey) ||
      !chat.setStatus(id, "pending", null, peerKey)
    )
      return;
    if (relays.getStatus() === "offline") startAgain();
    void flush();
  }

  function startAgain() {
    relays.reconnect();
    for (const [relay, watcher] of watchers) {
      if (syncing.get(relay.url) === "failed") watcher.refresh();
    }
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
    const inboxes = relays.inboxRelays().slice(0, 3);
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
    for (const relay of inboxes) {
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
              (opened) => opened.senderKey === peerKey,
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

  return {
    getChatsEnabled: () => chatsEnabled,
    setChatsEnabled(enabled: boolean) {
      if (enabled === chatsEnabled) return;
      writeState(chatsEnabledKey, String(enabled));
      chatsEnabled = enabled;
      chatGeneration++;
      requestCatchup?.();
      updateUnlocks();
      syncWatches();
      if (enabled) void flush();
      for (const listener of listeners) listener();
    },
    start,
    stop,
    reconnect: startAgain,
    catchupRequest,
    setUnlockActive,
    invalidateBlockedPeer() {
      if (!unlockActive) return;
      setUnlockActive(false);
      setUnlockActive(true);
    },
    getInboxSync: () => inboxSync,
    getHistoryReady,
    send,
    editMessage,
    retryEdit,
    sendAttachment,
    cancelAttachment,
    pauseAttachment,
    retry,
    toggleReaction,
    getStatus: relays.getStatus,
    subscribeStatus: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
