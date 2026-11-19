import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import NDK, { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  admission,
  callCapacity,
  type Reservation,
} from "../src/core/calling/conference";
import {
  type CallRecord,
  createCallController,
  type OpenMedia,
} from "../src/core/calling/controller";
import {
  type CallSignal,
  callSignalKind,
  type InviteSignal,
  parseCallSignal,
} from "../src/core/calling/signals";
import {
  createRumor,
  unwrapPrivateEvent,
  wrapRumor,
} from "../src/core/messaging/nip17";
import migrations from "../src/db/migrations/bundle";
import { callById, callList, saveCallRecord } from "../src/db/queries";
import * as schema from "../src/db/schema";

const id = (value: number) => value.toString(16).padStart(64, "0");
const signers = Array.from(
  { length: 7 },
  (_, n) => new NDKPrivateKeySigner(id(n + 1)),
);
const [alice, bob, charlie, dana, eve, frank, outsider] = signers.map(
  (key) => key.pubkey,
);
const callId = id(16);
const start = 1_700_000_000_000;
function reservation(
  recipient: string,
  roster: string[],
  n = 100,
): Reservation {
  return {
    version: 1,
    callId,
    expiresAt: start + 35_000,
    recipient,
    invitation: { id: id(n), roster, capacity: callCapacity },
  };
}

test("incumbents reserve the exact connected roster and admit an accepted identity once", () => {
  let time = start;
  let aRoster = [bob];
  let bRoster = [alice];
  const a = admission({
    localKey: alice,
    callId,
    connected: () => aRoster,
    now: () => time,
  });
  const b = admission({
    localKey: bob,
    callId,
    connected: () => bRoster,
    now: () => time,
  });
  const first = reservation(charlie, [alice, bob]);
  expect(b.reserve(first, outsider)).toBe(false);
  expect(b.reserve(reservation(charlie, [alice, eve]), alice)).toBe(false);
  expect(a.reserve(first, alice)).toBe(true);
  expect(b.reserve(first, alice)).toBe(true);
  expect(b.reserve(first, alice)).toBe(true);
  expect(b.reserve(reservation(dana, [alice, bob], 101), bob)).toBe(false);
  expect(b.authorize(first.invitation.id, bob)).toBe(false);
  expect(b.permits(charlie)).toBe(false);
  expect(b.authorize(first.invitation.id, alice)).toBe(true);
  expect(a.authorize(first.invitation.id, alice)).toBe(true);
  expect(a.permits(charlie)).toBe(true);
  expect(b.permits(outsider)).toBe(false);
  a.consume(charlie);
  b.consume(charlie);
  aRoster = [bob, charlie];
  bRoster = [alice, charlie];
  const c = admission({
    localKey: charlie,
    callId,
    connected: () => [alice, bob],
    now: () => time,
  });
  const fourth = reservation(dana, [alice, bob, charlie], 101);
  for (const peer of [a, b, c]) {
    expect(peer.reserve(fourth, bob)).toBe(true);
    expect(peer.authorize(fourth.invitation.id, bob)).toBe(true);
    expect(peer.permits(dana)).toBe(true);
  }
  aRoster = [charlie];
  expect(a.permits(dana)).toBe(false);
  b.release(fourth.invitation.id, bob);
  expect(b.permits(dana)).toBe(false);
  expect(b.authorize(fourth.invitation.id, bob)).toBe(false);
  time = fourth.expiresAt;
  expect(c.permits(dana)).toBe(false);
  expect(c.reserve(fourth, bob)).toBe(false);
});

test("simultaneous reservations cannot overbook an honest current member", () => {
  const a = admission({
    localKey: alice,
    callId,
    connected: () => [bob, charlie, dana, eve],
    now: () => start,
  });
  const roster = [alice, bob, charlie, dana, eve];
  expect(a.reserve(reservation(frank, roster), alice)).toBe(true);
  expect(a.reserve(reservation(outsider, roster, 101), bob)).toBe(false);
  a.consume(frank);
  expect(a.reserve(reservation(outsider, [...roster, frank], 102), bob)).toBe(
    false,
  );
});

test("six-seat conference setup is encrypted to the invitee, and the roster binds the inviter", async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const invite: InviteSignal = {
    version: 1,
    expandable: 2,
    type: "call.invite",
    senderKey: alice,
    recipientKey: frank,
    callId,
    nonce: id(3),
    roomId: id(10),
    roomSecret: id(11),
    createdAt: now,
    expiresAt: now + 35_000,
    conference: reservation(frank, [alice, bob, charlie, dana, eve]).invitation,
  };
  const rumor = createRumor({
    kind: callSignalKind,
    pubkey: alice,
    content: JSON.stringify(invite),
    tags: [["p", frank]],
    created_at: now / 1000,
  });
  const wrapped = await wrapRumor(new NDK(), rumor, frank, signers[0]);
  expect(wrapped.rawEvent().content).not.toContain(invite.roomSecret);
  const parseAsInvitee = (content: string) =>
    parseCallSignal(
      content,
      {
        senderKey: alice,
        recipientKey: frank,
        sentAt: now,
      },
      now,
    );
  expect(parseAsInvitee(rumor.content)).toEqual(invite);
  expect(
    parseAsInvitee(
      JSON.stringify({
        ...invite,
        conference: { ...invite.conference, roster: [bob, frank] },
      }),
    ),
  ).toBeNull();
  expect(
    await unwrapPrivateEvent(wrapped.rawEvent(), signers[5]),
  ).toMatchObject({ type: "call", signal: invite });
  expect(await unwrapPrivateEvent(wrapped.rawEvent(), signers[6])).toBeNull();
});

test("connected controller handles invitation ringing, busy, cancellation, subsequent admission and one history record", async () => {
  const sent: CallSignal[] = [];
  const records: CallRecord[] = [];
  let updateMembers: Parameters<OpenMedia>[0]["onParticipants"];
  const authorize: string[] = [];
  const release: string[] = [];
  let counter = 50;
  const controller = createCallController({
    localKey: alice,
    randomId: () => id(counter++),
    now: () => start,
    send: async (signal) => {
      sent.push(signal);
      return true;
    },
    openMedia: async ({ onParticipants }) => {
      updateMembers = onParticipants;
      updateMembers?.([
        {
          key: bob,
          volume: 100,
          muted: false,
          silenced: false,
          speaking: false,
        },
      ]);
      return {
        close() {},
        mute() {},
        async route() {},
        conference: {
          async reserve() {
            return true;
          },
          async authorize(value) {
            authorize.push(value);
            return true;
          },
          release: (value) => release.push(value),
          silence() {},
          volume() {},
        },
      };
    },
    record: (entry) => records.push(entry),
    tone() {},
  });
  const answer = (
    invite: InviteSignal,
    type: "call.accept" | "call.ringing" | "call.busy",
  ) =>
    controller.receive({
      type,
      version: 1,
      callId: invite.callId,
      nonce: id(counter++),
      senderKey: invite.recipientKey,
      recipientKey: alice,
      createdAt: start,
      expiresAt: start + 35_000,
      invitationId: invite.conference?.id,
    });
  const lastInvite = () => {
    const invite = sent.findLast((event) => event.type === "call.invite");
    if (!invite) throw new Error("Invitation did not publish");
    return invite;
  };
  try {
    controller.setForeground(true);
    controller.dial(bob);
    const initial = lastInvite();
    answer(initial, "call.accept");
    await Bun.sleep(0);
    expect(controller.store.getState().call?.phase).toBe("connected");
    expect(await controller.invite(charlie)).toBe(true);
    expect(await controller.invite(dana)).toBe(false);
    const first = lastInvite();
    if (!first.conference) throw new Error("No conference");
    expect(first.callId).toBe(initial.callId);
    expect(first.roomId).toBe(initial.roomId);
    expect(first.roomSecret).toBe(initial.roomSecret);
    answer(first, "call.ringing");
    expect(controller.store.getState().invitations[0]?.phase).toBe("ringing");
    answer(first, "call.busy");
    expect(controller.store.getState().invitations[0]?.phase).toBe("busy");
    expect(await controller.invite(charlie)).toBe(true);
    const second = lastInvite();
    if (!second.conference) throw new Error("No conference");
    controller.cancelInvitation();
    answer(second, "call.accept");
    expect(authorize).toEqual([]);
    expect(release).toEqual([first.conference.id, second.conference.id]);
    expect(await controller.invite(charlie)).toBe(true);
    const third = lastInvite();
    if (!third.conference) throw new Error("No conference");
    answer(third, "call.accept");
    expect(authorize).toEqual([third.conference.id]);
    updateMembers?.(
      [bob, charlie].map((key) => ({
        key,
        volume: 100,
        muted: false,
        silenced: false,
        speaking: false,
      })),
    );
    expect(controller.store.getState().invitations).toEqual([]);
    updateMembers?.([
      {
        key: charlie,
        volume: 100,
        muted: false,
        silenced: false,
        speaking: false,
      },
    ]);
    expect(controller.store.getState().call).toMatchObject({
      id: initial.callId,
      phase: "connected",
      answeredAt: start,
    });
  } finally {
    controller.end();
    await Bun.sleep(0);
  }
  expect(records).toHaveLength(1);
  expect(records[0]?.participantKeys).toEqual([bob, charlie]);
});

test("conference history migration preserves legacy calls and reads all participant identities", () => {
  using sqlite = new Database(":memory:");
  const queries = Object.values(migrations.migrations);
  for (const query of queries.slice(0, -1)) sqlite.exec(query);
  sqlite.run(
    "INSERT INTO call_history (id, peer_key, direction, outcome, started_at) VALUES ('legacy', ?, 'incoming', 'completed', 0)",
    [bob],
  );
  sqlite.exec(queries.at(-1) ?? "");
  const db = drizzle(sqlite, { schema });
  db.insert(schema.callHistory)
    .values({
      id: "group",
      peerKey: bob,
      direction: "outgoing",
      outcome: "completed",
      startedAt: 1000,
      participantKeys: [bob, charlie, dana],
    })
    .run();
  expect(
    callList(db)
      .all()
      .map(({ id, participantKeys }) => [id, participantKeys]),
  ).toEqual([
    ["group", [bob, charlie, dana]],
    ["legacy", []],
  ]);
});

test("retrying after a rejected invitation keeps one history record and ignores duplicate completion", () => {
  using sqlite = new Database(":memory:");
  for (const query of Object.values(migrations.migrations)) sqlite.exec(query);
  const db = drizzle(sqlite, { schema });
  const rejected = {
    id: callId,
    peerKey: alice,
    direction: "incoming" as const,
    outcome: "rejected" as const,
    startedAt: start,
    endedAt: start + 1_000,
    participantKeys: [alice],
    invitationIds: [id(31)],
  };
  saveCallRecord(db, rejected);
  const joined = {
    ...rejected,
    outcome: "completed" as const,
    answeredAt: start + 3_000,
    endedAt: start + 8_000,
    durationSeconds: 5,
    participantKeys: [alice, bob],
    invitationIds: [id(32)],
  };
  saveCallRecord(db, joined);
  saveCallRecord(db, joined);
  expect(callList(db).all()).toHaveLength(1);
  expect(callById(db, callId)).toMatchObject({
    outcome: "completed",
    durationSeconds: 5,
    participantKeys: [alice, bob],
    invitationIds: [id(31), id(32)],
  });
});
