import { expect, test } from "bun:test";
import type { CallView } from "../src/core/calling/controller";
import {
  systemCallCommand,
  systemRemoteVideo,
} from "../src/core/calling/system-call-state";
import { createVideoSession } from "../src/core/calling/video";

const call = {
  id: "1".repeat(64),
  peerKey: "2".repeat(64),
  phase: "connected",
  startedAt: 10,
  answeredAt: 20,
  direction: "outgoing",
  muted: false,
  remoteMuted: false,
  reconnecting: false,
  routing: { available: [], selected: null },
} satisfies CallView;

test("system actions cannot apply to stale, malformed or ended calls", () => {
  const hangup = { kind: "end", callId: call.id };
  expect(systemCallCommand(call, hangup)).toEqual({
    kind: "end",
    callId: call.id,
  });
  expect(systemCallCommand(call, { ...hangup, callId: "stale" })).toBeNull();
  expect(
    systemCallCommand(call, { kind: "unknown", callId: call.id }),
  ).toBeNull();
  expect(systemCallCommand({ ...call, phase: "ending" }, hangup)).toBeNull();
});

test("only decoded, authorized remote video is eligible for system PiP", async () => {
  let foreground = true;
  const sources: (string | null)[] = [];
  const privateSources: (string | null)[] = [];
  const session = createVideoSession({
    callId: call.id,
    capture: async () => ({
      url: "local",
      attach: async () => undefined,
      stop() {},
      switchTo: async () => undefined,
    }),
    offer: async (offer) => {
      return {
        version: 1,
        callId: offer.callId,
        sequence: offer.sequence,
        allowed: true,
      };
    },
    stop() {},
    policy: () => "ask",
    allowAlways: () => false,
    foreground: () => foreground,
    update: (video) => {
      sources.push(systemRemoteVideo(call, video, false));
      privateSources.push(systemRemoteVideo(call, video, true));
    },
  });
  await session.enable();
  expect(sources.at(-1)).toBeNull();
  const offer = { type: "offer", version: 1, callId: call.id, sequence: 1 };
  const decision = session.receiveOffer(offer);
  session.respond(1, "allow-once");
  await expect(decision).resolves.toMatchObject({ allowed: true });
  expect(sources.at(-1)).toBeNull();
  session.received(1, "remote");
  expect(sources.at(-1)).toBe("remote");
  expect(privateSources.at(-1)).toBeNull();
  session.swap();
  expect(sources.at(-1)).toBe("remote");
  session.suspendCamera();
  expect(sources.at(-1)).toBe("remote");
  foreground = false;
  const backgroundOffer = session.receiveOffer({ ...offer, sequence: 2 });
  expect(backgroundOffer).toBeInstanceOf(Promise);
  expect(sources.at(-1)).toBeNull();
  session.close();
  await expect(backgroundOffer).resolves.toMatchObject({ allowed: false });
  expect(sources.at(-1)).toBeNull();
});
