import { expect, test } from "bun:test";
import type { OfferRecord, StrategyOnMessage } from "@trystero-p2p/core";
import { directSignaling } from "../src/core/calling/direct-signaling";
import type {
  InviteDraft,
  RtcPayload,
  RtcSignal,
} from "../src/core/calling/signals";

const caller = "a".repeat(64);
const callee = "b".repeat(64);
const other = "c".repeat(64);
const callerId = "A".repeat(20);
const answererId = "B".repeat(20);
const offerId = "O".repeat(20);
const callId = "d".repeat(64);
const clock = Date.now();
const expiresAt = clock + 30_000;
const invite: InviteDraft = {
  version: 1,
  type: "call.invite",
  senderKey: caller,
  recipientKey: callee,
  callId,
  nonce: "e".repeat(64),
  roomId: "f".repeat(64),
  createdAt: clock,
  expiresAt,
};

function setup() {
  const abort = new AbortController();
  const messages: RtcSignal[] = [];
  const events: unknown[] = [];
  const actions: string[] = [];
  const handle = {} as OfferRecord["peer"];
  const lease = {
    peer: handle,
    offer: "encrypted offer",
    offerId,
    reclaim: () => actions.push("reclaimed"),
  };
  const signaling = directSignaling({
    invite,
    localKey: caller,
    signal: abort.signal,
    randomId: () => "1".repeat(64),
    publish: async (message) => {
      messages.push(message);
      return true;
    },
  });
  const inbound: StrategyOnMessage = async (_topic, payload) => {
    events.push(payload);
  };
  signaling.adapter.subscribe(
    null,
    "private room",
    "local topic",
    inbound,
    async (_count, onCandidate) => {
      onCandidate?.(offerId, "encrypted local candidate");
      return [lease];
    },
    {
      config: { appId: "test" },
      appId: "test",
      roomId: invite.roomId,
      peerId: callerId,
    },
  );
  const from = (
    payload: RtcPayload,
    fields: Partial<RtcSignal> = {},
  ): RtcSignal => ({
    version: 1,
    type: "call.rtc",
    senderKey: callee,
    recipientKey: caller,
    callId,
    nonce: "2".repeat(64),
    createdAt: clock,
    expiresAt,
    payload,
    ...fields,
  });
  return { signaling, events, actions, messages, handle, from };
}

test("a prepared invite claims its original handle only for its authenticated recipient", async () => {
  const { signaling, events, messages, handle, from } = setup();
  try {
    expect(await signaling.prepare(callee, { expiresAt })).toEqual({
      peerId: callerId,
      offerId,
      offer: "encrypted offer",
    });
    const answer = { peerId: answererId, offerId, answer: "encrypted answer" };
    await signaling.receive(from(answer));
    expect(events).toHaveLength(0);
    signaling.scopeFor((key) => (key === callee ? { expiresAt } : undefined));
    signaling.startCandidates(callee);
    await Bun.sleep(0);
    expect(events).toEqual([{ ...answer, peer: handle }]);
    expect(signaling.matches(callee, answererId)).toBe(true);
    await signaling.receive(from(answer));
    await signaling.receive(from(answer, { senderKey: other }));
    expect(events).toHaveLength(1);
    await Bun.sleep(60);
    expect(messages.map(({ payload }) => payload)).toEqual([
      {
        peerId: callerId,
        offerId,
        candidates: ["encrypted local candidate"],
      },
    ]);
  } finally {
    signaling.close();
  }
});

test("candidates wait for the matching answer and stale, duplicate and cross-call data are discarded", async () => {
  const { signaling, events, handle, from } = setup();
  try {
    await signaling.prepare(callee, { expiresAt });
    signaling.scopeFor((key) => (key === callee ? { expiresAt } : undefined));
    const response = { peerId: answererId, offerId };
    const candidate = { ...response, candidates: ["incoming ICE"] };
    await signaling.receive(from(candidate));
    await signaling.receive(
      from({ ...candidate, peerId: "X".repeat(20), candidates: ["wrong ICE"] }),
    );
    await signaling.receive(
      from({ ...response, answer: "expired" }, { expiresAt: clock - 1 }),
    );
    await signaling.receive(
      from({ ...response, answer: "other call" }, { callId: "0".repeat(64) }),
    );
    await signaling.receive(
      from({ ...response, answer: "bad offer id", offerId: "Z".repeat(20) }),
    );
    expect(events).toHaveLength(0);
    await signaling.receive(from({ ...response, answer: "accepted" }));
    await signaling.receive(from(candidate));
    expect(events).toEqual([
      { ...response, answer: "accepted", peer: handle },
      { ...response, candidate: "incoming ICE", peer: handle },
    ]);
    signaling.connected(callee);
    await signaling.receive(from({ ...response, candidates: ["late ICE"] }));
    expect(events).toHaveLength(2);
  } finally {
    signaling.close();
  }
});

test("closing the room reclaims its unused lease and discards late answers", async () => {
  const { signaling, events, actions, from } = setup();
  await signaling.prepare(callee, { expiresAt });
  signaling.close();
  signaling.close();
  await signaling.receive(
    from({ peerId: answererId, offerId, answer: "cancelled" }),
  );
  expect(actions).toEqual(["reclaimed"]);
  expect(events).toEqual([]);
});

test("replacement signaling binds a fresh lease to the recovery scope", async () => {
  const { signaling, events, messages, handle, from } = setup();
  try {
    signaling.scopeFor((key, message) =>
      key === callee && message.recovery
        ? { recovery: true, expiresAt }
        : undefined,
    );
    expect(await signaling.offer(callee, { recovery: true, expiresAt })).toBe(
      true,
    );
    expect(messages[0]).toMatchObject({
      recovery: true,
      recipientKey: callee,
      payload: { peerId: callerId, offerId },
    });
    const answer = {
      peerId: answererId,
      offerId,
      answer: "encrypted recovery answer",
    };
    await signaling.receive(from(answer));
    await signaling.receive(from(answer, { recovery: true, senderKey: other }));
    expect(events).toEqual([]);
    await signaling.receive(from(answer, { recovery: true }));
    expect(events).toEqual([{ ...answer, peer: handle }]);
  } finally {
    signaling.close();
  }
});
