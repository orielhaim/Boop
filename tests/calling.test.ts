import { expect, test } from "bun:test";
import NDK, { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { finalizeEvent } from "nostr-tools/pure";
import {
  type CallMedia,
  type CallRecord,
  createCallController,
  type OpenMedia,
} from "../src/core/calling/controller";
import {
  discoverGroupCall,
  groupCallAnnouncement,
  groupCallLease,
} from "../src/core/calling/group-presence";
import {
  peerTranscript,
  proofKind,
  verifyPeerProof,
} from "../src/core/calling/protocol";
import {
  type CallSignal,
  callSignalKind,
  type InviteSignal,
  parseCallSignal,
} from "../src/core/calling/signals";
import { unsignedRumor, wrapRumor } from "../src/core/nostr/gift-wrap";
import {
  unwrapCallSignal,
  callReplyRelayTag,
} from "../src/core/calling/signaling-service";

const caller = new NDKPrivateKeySigner("01".repeat(32));
const callee = new NDKPrivateKeySigner("02".repeat(32));
const third = new NDKPrivateKeySigner("03".repeat(32));
const id = (n: number) => n.toString(16).padStart(64, "0");

function invitation(now: number): InviteSignal {
  const createdAt = Math.floor(now / 1000) * 1000;
  return {
    version: 1,
    type: "call.invite",
    callId: id(1),
    nonce: id(2),
    roomId: id(3),
    offer: { peerId: "A".repeat(20), offerId: "O".repeat(20), offer: "opaque" },
    senderKey: caller.pubkey,
    recipientKey: callee.pubkey,
    createdAt,
    expiresAt: createdAt + 35000,
  };
}

test("signed NIP-59 call rumor reaches only its intended inbox, expires, and stays outside chat", async () => {
  const invite = invitation(Date.now());
  const replyRelay = "wss://relay.example/";
  const rumor = unsignedRumor({
    kind: callSignalKind,
    pubkey: invite.senderKey,
    content: JSON.stringify(invite),
    tags: [
      ["p", invite.recipientKey],
      [callReplyRelayTag, replyRelay],
    ],
    created_at: invite.createdAt / 1000,
  });
  const wrapped = await wrapRumor(new NDK(), rumor, callee.pubkey, caller);
  expect(wrapped.rawEvent().kind).toBe(1059);
  expect(wrapped.rawEvent().content).not.toContain(invite.roomId);
  expect(JSON.stringify(wrapped.rawEvent())).not.toContain(replyRelay);
  expect(await unwrapCallSignal(wrapped.rawEvent(), callee)).toMatchObject({
    id: rumor.id,
    signal: invite,
    replyRelays: [replyRelay],
  });
  expect(await unwrapCallSignal(wrapped.rawEvent(), third)).toBeNull();
  expect(
    await unwrapCallSignal(
      wrapped.rawEvent(),
      callee,
      (key) => key === caller.pubkey,
    ),
  ).toBeNull();
  const envelope = {
    senderKey: caller.pubkey,
    recipientKey: callee.pubkey,
    sentAt: invite.createdAt,
  };
  expect(parseCallSignal(rumor.content, envelope, invite.expiresAt)).toBeNull();
  expect(
    parseCallSignal(
      rumor.content,
      { ...envelope, senderKey: third.pubkey },
      invite.createdAt,
    ),
  ).toBeNull();
  expect(
    parseCallSignal(
      JSON.stringify({ ...invite, extra: true }),
      envelope,
      invite.createdAt,
    ),
  ).toBeNull();
});

test("proof binds both actual certificate fingerprints, identities, fresh challenge and room", () => {
  const fingerprint = (hex: string) =>
    `a=fingerprint:sha-256 ${Array.from({ length: 32 }, () => hex).join(":")}`;
  const challenge = {
    callId: id(1),
    roomId: id(3),
    challenge: id(9),
    sender: { id: "boop-one", key: caller.pubkey, sdp: fingerprint("AA") },
    recipient: { id: "boop-two", key: callee.pubkey, sdp: fingerprint("BB") },
  };
  const expected = peerTranscript(challenge);
  const proof = finalizeEvent(
    { kind: proofKind, created_at: 1000, tags: [], content: expected },
    new Uint8Array(32).fill(1),
  );
  expect(verifyPeerProof(proof, expected, caller.pubkey, 1000)).toBe(true);
  for (const changed of [
    { ...challenge, roomId: id(13) },
    { ...challenge, challenge: id(15) },
    { ...challenge, sender: { ...challenge.sender, sdp: fingerprint("AB") } },
    {
      ...challenge,
      recipient: { ...challenge.recipient, sdp: fingerprint("AC") },
    },
    { ...challenge, recipient: { ...challenge.recipient, id: "reconnect" } },
  ])
    expect(
      verifyPeerProof(proof, peerTranscript(changed), caller.pubkey, 1000),
    ).toBe(false);
  expect(verifyPeerProof(proof, expected, caller.pubkey, 1031)).toBe(false);
});

function pair(
  openMedia?: OpenMedia,
  connectTimeout?: number,
  acceptAcknowledgment?: Promise<boolean>,
  backgroundAudio = false,
  authorizeGroup?: (group: string, peers: string[]) => Promise<boolean>,
) {
  const events: CallSignal[] = [];
  const records: CallRecord[] = [];
  const closed: string[] = [];
  const hangups = new Map<string, () => void>();
  let nonce = 20;
  let clock = 1_700_000_000_000;
  const build = (localKey: string) =>
    createCallController({
      localKey,
      authorizeGroup,
      randomId: () => id(nonce++),
      prepareInvite: async () => invitation(clock).offer,
      send: async (signal) => {
        events.push(signal);
        if (signal.type === "call.accept" && acceptAcknowledgment)
          return acceptAcknowledgment;
        return true;
      },
      openMedia:
        openMedia ??
        (async ({ peerKey, onHangup, onAuthenticated }) => {
          hangups.set(localKey, onHangup);
          const notifyHangup = async () => hangups.get(peerKey)?.();
          onAuthenticated({ notifyHangup });
          return {
            backgroundAudio,
            close: () => {
              hangups.delete(localKey);
              closed.push(localKey);
            },
            notifyHangup,
            mute() {},
            async route() {},
          };
        }),
      record: (entry) => records.push(entry),
      tone() {},
      now: () => clock,
      connectTimeout,
    });
  const a = build(caller.pubkey);
  const b = build(callee.pubkey);
  a.setForeground(true);
  b.setForeground(true);
  const deliver = () => {
    for (const event of events.splice(0)) {
      (event.recipientKey === caller.pubkey ? a : b).receive(event);
    }
  };
  return {
    a,
    b,
    deliver,
    events,
    records,
    closed,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("a group call rechecks Marmot membership before answering while first-contact calls remain independent", async () => {
  const group = id(99);
  const members = new Set([caller.pubkey, callee.pubkey]);
  const { a, b, deliver, events } = pair(
    undefined,
    undefined,
    undefined,
    false,
    async (requestedGroup, peers) =>
      requestedGroup === group && peers.every((peer) => members.has(peer)),
  );
  try {
    expect(await a.dial(third.pubkey, group)).toBe(false);
    expect(events).toEqual([]);
    expect(await a.dial(callee.pubkey, group)).toBe(true);
    expect(events[0]).toMatchObject({ type: "call.invite", groupId: group });
    deliver();
    await Bun.sleep(0);
    expect(b.store.getState().call).toMatchObject({
      phase: "incoming",
      groupId: group,
    });
    members.delete(caller.pubkey);
    b.accept();
    await Bun.sleep(0);
    expect(b.store.getState().call).toMatchObject({
      phase: "ended",
      outcome: "failed",
    });
    expect(events.some((event) => event.type === "call.accept")).toBe(false);
    a.end();
    events.length = 0;
    expect(await a.dial(callee.pubkey)).toBe(true);
    deliver();
    expect(b.store.getState().call).toMatchObject({ phase: "incoming" });
    expect(b.store.getState().call?.groupId).toBeUndefined();
  } finally {
    a.end();
    b.end();
  }
});

test("group discovery accepts a solo lobby, switches coordinators, and expires the lease", () => {
  const now = 1_700_000_000_000;
  const call = id(99);
  const members = new Set([caller.pubkey, callee.pubkey, third.pubkey]);
  const active = (
    sender: string,
    users: string[],
    time = now,
    ended = false,
  ) => ({
    sender,
    text: groupCallAnnouncement(call, users, time, ended),
    sentAt: Math.floor(time / 1000),
    deleted: false,
    invalidated: false,
  });
  const rows = [active(caller.pubkey, [caller.pubkey])];
  const discover = (at = now) =>
    discoverGroupCall(rows, (key) => members.has(key), at);
  expect(discover()).toMatchObject({
    call,
    coordinator: caller.pubkey,
    routes: [caller.pubkey],
  });
  rows.push(active(third.pubkey, [caller.pubkey], now + 2));
  expect(discover()?.coordinator).toBe(caller.pubkey);
  rows.push(
    active(caller.pubkey, [], now + 3),
    active(callee.pubkey, [callee.pubkey], now + 4),
  );
  expect(discover()).toMatchObject({ call, coordinator: callee.pubkey });
  expect(discover(now + groupCallLease + 4)).toBeUndefined();
  rows.push(active(callee.pubkey, [], now + 5, true));
  expect(discover()).toBeUndefined();
});

test("an uninvited group member joins through a correlated encrypted-control offer and loses admission on removal", async () => {
  const group = id(100);
  const events: CallSignal[] = [];
  const roster = new Set([caller.pubkey, callee.pubkey, third.pubkey]);
  let nonce = 1000;
  const now = Date.now();
  const revoked: string[] = [];
  const remoteHangup = new Map<string, () => void>();
  const offline = new Set<string>();
  const build = (localKey: string) => {
    const instance = createCallController({
      localKey,
      now: () => now,
      randomId: () => id(nonce++),
      authorizeGroup: async (id, peers) =>
        id === group &&
        roster.has(localKey) &&
        peers.every((key) => roster.has(key)),
      prepareInvite: async () => invitation(now).offer,
      send: async (signal) => {
        events.push(signal);
        return !offline.has(signal.recipientKey);
      },
      openMedia: async ({
        invite,
        peerKey,
        onAuthenticated,
        onParticipants,
        onHangup,
      }) => {
        const notifyHangup = async () => {};
        remoteHangup.set(localKey, onHangup);
        onAuthenticated({ notifyHangup });
        onParticipants?.(
          (invite.conference?.roster ?? [peerKey])
            .filter((key) => key !== localKey)
            .map((key) => ({
              key,
              muted: false,
              silenced: false,
              volume: 100,
              speaking: false,
            })),
        );
        return {
          notifyHangup,
          close() {},
          mute() {},
          async route() {},
          conference: {
            async reserve() {
              return true;
            },
            async authorize() {
              return true;
            },
            revokePeer(key) {
              revoked.push(key);
            },
            release() {},
            silence() {},
            volume() {},
          },
        };
      },
      record() {},
      tone() {},
    });
    instance.setForeground(true);
    return instance;
  };
  const alice = build(caller.pubkey);
  const bob = build(callee.pubkey);
  const charlie = build(third.pubkey);
  const clients = new Map([
    [caller.pubkey, alice],
    [callee.pubkey, bob],
    [third.pubkey, charlie],
  ]);
  async function deliver() {
    for (let i = 0; i < 5; i++) {
      for (const event of events.splice(0))
        clients.get(event.recipientKey)?.receive(event);
      await Bun.sleep(0);
    }
  }
  try {
    expect(await alice.startGroup(group)).toBe(true);
    const lobby = alice.store.getState().groupLobby;
    if (!lobby) throw new Error("Group lobby missing");
    expect(alice.store.getState().call).toBeNull();
    expect(await bob.join(group, lobby.callId, [caller.pubkey])).toBe(true);
    await deliver();
    const call = alice.store.getState().call;
    if (call?.phase !== "connected")
      throw new Error("Initial conference did not connect");
    alice.end();
    remoteHangup.get(callee.pubkey)?.();
    offline.add(caller.pubkey);
    expect(bob.store.getState().groupLobby).toEqual({
      callId: call.id,
      groupId: group,
    });
    expect(
      await charlie.join(group, call.id, [caller.pubkey, callee.pubkey]),
    ).toBe(true);
    expect(
      events
        .filter((event) => event.type === "call.join")
        .map((event) => event.recipientKey),
    ).toEqual([caller.pubkey, callee.pubkey]);
    await deliver();
    expect(charlie.store.getState().call).toMatchObject({
      phase: "connected",
      id: call.id,
      groupId: group,
    });
    expect(charlie.store.getState().joining).toBeUndefined();
    const connected = bob.store.getState().participants;
    offline.delete(caller.pubkey);
    bob.store.setState({
      participants: Array.from({ length: 5 }, (_, index) => ({
        key: id(1500 + index),
        muted: false,
        silenced: false,
        volume: 100,
        speaking: false,
      })),
    });
    expect(await alice.join(group, call.id, [callee.pubkey])).toBe(true);
    await deliver();
    expect(alice.store.getState().fullGroupCall?.callId).toBe(call.id);
    expect(alice.store.getState().joining).toBeUndefined();
    bob.store.setState({ participants: connected });
    charlie.peerBlocked(callee.pubkey);
    expect(charlie.store.getState().call?.phase).toBe("connected");
    expect(revoked).toEqual([callee.pubkey]);
    revoked.length = 0;
    roster.delete(third.pubkey);
    charlie.reconcileGroup(group, roster);
    expect(charlie.store.getState().call?.phase).toBe("ended");
    expect(await charlie.join(group, call.id, [callee.pubkey])).toBe(false);
    expect(bob.store.getState().call?.phase).toBe("connected");
    expect(revoked).toEqual([]);
  } finally {
    for (const client of clients.values()) client.end();
  }
});

test("answer starts transport while waiting for relay acknowledgment and closes it when publication fails", async () => {
  const acknowledgment = Promise.withResolvers<boolean>();
  let started = false;
  let closed = false;
  const { a, b, deliver } = pair(
    async () => {
      started = true;
      return {
        close: () => {
          closed = true;
        },
        mute() {},
        async route() {},
      };
    },
    undefined,
    acknowledgment.promise,
  );
  try {
    await a.dial(callee.pubkey);
    deliver();
    b.accept();
    expect(started).toBe(true);
    expect(b.store.getState().call?.phase).toBe("connecting");
    acknowledgment.resolve(false);
    await Bun.sleep(0);
    expect(closed).toBe(true);
    expect(b.store.getState().call).toMatchObject({
      phase: "ended",
      outcome: "failed",
    });
  } finally {
    acknowledgment.resolve(false);
    a.end();
    b.end();
  }
});

test("ringing waits for recipient, connected waits for media, and remote hangup records once", async () => {
  const { a, b, deliver, advance, records, closed, events } = pair();
  await a.dial(callee.pubkey);
  const initial = events[0];
  if (initial?.type !== "call.invite") throw new Error("No invitation");
  expect(a.store.getState().call?.phase).toBe("outgoing");
  deliver();
  expect(b.store.getState().call?.phase).toBe("incoming");
  deliver();
  expect(a.store.getState().call?.phase).toBe("ringing");
  b.accept();
  expect(b.store.getState().call?.phase).toBe("connecting");
  deliver();
  expect(a.store.getState().call?.phase).toBe("connecting");
  await Bun.sleep(0);
  expect(a.store.getState().call?.phase).toBe("connected");
  expect(b.store.getState().call?.phase).toBe("connected");
  const { roomId: _id, offer: _offer, ...relaySignal } = initial;
  b.receive({ ...relaySignal, type: "call.end" });
  expect(b.store.getState().call?.phase).toBe("connected");
  advance(5100);
  a.end();
  a.end();
  await Bun.sleep(0);
  expect(events).toEqual([]);
  expect(
    records.map(({ outcome, durationSeconds }) => [outcome, durationSeconds]),
  ).toEqual([
    ["completed", 5],
    ["completed", 5],
  ]);
  expect(closed).toHaveLength(2);
});

test("hangup uses the direct channel as soon as identity is verified, even before audio is ready", async () => {
  const pending = Promise.withResolvers<CallMedia>();
  let notified = 0;
  const { a, b, deliver, events } = pair(({ onAuthenticated }) => {
    onAuthenticated({
      notifyHangup: async () => {
        notified++;
      },
    });
    return pending.promise;
  });
  await a.dial(callee.pubkey);
  deliver();
  b.accept();
  deliver();
  expect(a.store.getState().call?.phase).toBe("connecting");
  a.end();
  b.end();
  await Bun.sleep(0);
  expect(notified).toBe(2);
  expect(events).toEqual([]);
  expect(a.store.getState().call).toMatchObject({
    phase: "ended",
    outcome: "cancelled",
  });
  expect(b.store.getState().call).toMatchObject({
    phase: "ended",
    outcome: "cancelled",
  });
  pending.resolve({ close() {}, mute() {}, async route() {} });
});

test("late acceptance and reordered invitations do not restart cancelled calls", async () => {
  const { a, b, events, deliver, records } = pair();
  await a.dial(callee.pubkey);
  const invite = events.shift();
  if (invite?.type !== "call.invite") throw new Error("No invitation");
  a.end();
  deliver();
  b.receive(invite);
  b.receive(invite);
  const { roomId: _room, offer: _offer, ...details } = invite;
  a.receive({
    ...details,
    type: "call.accept",
    senderKey: callee.pubkey,
    recipientKey: caller.pubkey,
  });
  expect(a.store.getState().call).toMatchObject({
    phase: "ended",
    outcome: "cancelled",
  });
  expect(b.store.getState().call).toBeNull();
  expect(records).toHaveLength(1);
});

test("duplicates, Busy, and Decline preserve the first incoming call", async () => {
  const { a, b, deliver, events, records } = pair();
  await a.dial(callee.pubkey);
  const invite = events.at(0);
  if (invite?.type !== "call.invite") throw new Error("No invitation");
  deliver();
  b.receive(invite);
  b.receive({ ...invite, callId: id(99), senderKey: third.pubkey });
  expect(events.map((event) => event.type)).toEqual([
    "call.ringing",
    "call.busy",
  ]);
  events.pop();
  deliver();
  b.end();
  deliver();
  expect(records.map(({ outcome }) => outcome)).toEqual([
    "rejected",
    "rejected",
  ]);
});

test("crossed calls choose one room deterministically", async () => {
  const { a, b, deliver } = pair();
  await a.dial(callee.pubkey);
  await b.dial(caller.pubkey);
  deliver();
  deliver();
  expect(a.store.getState().call?.id).toBe(b.store.getState().call?.id);
  expect(
    [a.store.getState().call?.phase, b.store.getState().call?.phase].sort(),
  ).toEqual(["incoming", "ringing"]);
  a.end();
  deliver();
});

test("cancel during media permission and close resources returned after teardown", async () => {
  const pending: ((media: CallMedia) => void)[] = [];
  const { a, b, deliver, records } = pair(
    () => new Promise((resolve) => pending.push(resolve)),
  );
  await a.dial(callee.pubkey);
  deliver();
  b.accept();
  deliver();
  await Bun.sleep(0);
  a.end();
  deliver();
  let closed = 0;
  for (const resolve of pending)
    resolve({ close: () => closed++, mute() {}, async route() {} });
  await Bun.sleep(0);
  expect(closed).toBe(2);
  expect(records).toHaveLength(2);
  expect(records.every((entry) => entry.answeredAt === null)).toBe(true);
});

test("microphone denial ends the attempt and reports a permission failure", async () => {
  const { a, b, deliver, records } = pair(async () => {
    throw new Error("microphone-permission");
  });
  await a.dial(callee.pubkey);
  deliver();
  b.accept();
  deliver();
  await Bun.sleep(0);
  expect(b.store.getState().call).toMatchObject({
    phase: "ended",
    outcome: "failed",
    reason: "microphonePermission",
  });
  expect(records.map((row) => row.durationSeconds)).toEqual([0, 0]);
});

test("negotiation times out and aborts both pending transports", async () => {
  const signals: AbortSignal[] = [];
  const { a, b, deliver, records } = pair(({ signal }) => {
    signals.push(signal);
    return new Promise(() => {});
  }, 5);
  await a.dial(callee.pubkey);
  deliver();
  b.accept();
  deliver();
  await Bun.sleep(15);
  expect(signals.map((value) => value.aborted)).toEqual([true, true]);
  expect(records.map(({ outcome }) => outcome)).toEqual(["failed", "failed"]);
});

test("the OS microphone prompt keeps the attempt pending without accepting new foreground invitations", async () => {
  const { a, b, deliver } = pair(async ({ onMicrophonePrompt }) => {
    onMicrophonePrompt(true);
    return new Promise(() => {});
  });
  await a.dial(callee.pubkey);
  deliver();
  b.accept();
  deliver();
  await Bun.sleep(0);
  expect(b.isRequestingMicrophone()).toBe(true);
  b.setForeground(false);
  expect(b.store.getState().call?.phase).toBe("connecting");
  const existing = b.store.getState().call?.id;
  b.receive(invitation(1_700_000_000_000));
  expect(b.store.getState().call?.id).toBe(existing);
  a.end();
  deliver();
  expect(b.store.getState().call?.phase).toBe("ended");
});

test("ongoing background audio keeps the authenticated session and records one system hangup", async () => {
  const { a, b, deliver, records, events, advance, closed } = pair(
    undefined,
    undefined,
    undefined,
    true,
  );
  await a.dial(callee.pubkey);
  deliver();
  b.accept();
  deliver();
  await Bun.sleep(0);
  const answered = a.store.getState().call;
  expect(answered?.phase).toBe("connected");
  a.setForeground(false);
  a.receive(invitation(1_700_000_000_000));
  expect(a.store.getState().call).toEqual(answered);
  expect(closed).toHaveLength(0);
  a.setForeground(true);
  a.setForeground(false);
  advance(12_000);
  a.end();
  a.end();
  await Bun.sleep(0);
  expect(events).toHaveLength(0);
  expect(
    records.map(({ durationSeconds, outcome }) => ({
      durationSeconds,
      outcome,
    })),
  ).toEqual([
    { durationSeconds: 12, outcome: "completed" },
    { durationSeconds: 12, outcome: "completed" },
  ]);
  expect(closed).toHaveLength(2);
});
