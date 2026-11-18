import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createMediaTurns } from "../src/core/calling/media-turn";
import {
  createVideoSession,
  type VideoState,
  videoLayout,
} from "../src/core/calling/video";
import migrations from "../src/db/migrations/bundle";
import { contacts } from "../src/db/schema";

const callId = "a".repeat(64);
const aliceKey = "b".repeat(64);
const bobKey = "c".repeat(64);
const camera = (sequence: number) => ({
  version: 1 as const,
  callId,
  sequence,
  kind: "camera" as const,
});
const offer = (sequence: number) => ({
  version: 1 as const,
  callId,
  sequence,
  type: "offer" as const,
});

function device(
  peer: () => ReturnType<typeof createVideoSession>,
  options?: {
    policy?: () => "unknown" | "ask" | "always";
    allowAlways?: () => boolean;
    timeout?: number;
    captureFailure?: string;
    startup?: Promise<void>;
  },
) {
  let state: VideoState | null = null;
  let transmitted = 0;
  let stopped = 0;
  const session = createVideoSession({
    callId,
    async capture() {
      if (options?.captureFailure) throw new Error(options.captureFailure);
      await options?.startup;
      return {
        url: "preview",
        async attach(metadata) {
          if (!peer().canReceive(metadata))
            throw new Error("Camera attached without approval");
          transmitted++;
        },
        stop() {
          stopped++;
        },
        async switchTo() {},
      };
    },
    offer: async (data, signal) => peer().receiveOffer(data, signal),
    stop: (data) => peer().receiveStop(data),
    policy: options?.policy ?? (() => "unknown"),
    allowAlways: options?.allowAlways ?? (() => false),
    timeout: options?.timeout,
    update: (value) => {
      state = value;
    },
  });
  session.initialize();
  return {
    session,
    state() {
      if (!state) throw new Error("Video session closed");
      return state;
    },
    usage: () => ({ transmitted, stopped }),
  };
}

test("denial stops capture, and approval gates transport independently in both directions", async () => {
  const alice = device(() => bob.session);
  const bob = device(() => alice.session);
  const initial = alice.session.enable();
  await Bun.sleep(0);
  expect(videoLayout(alice.state())).toMatchObject({
    source: "local",
    stageUrl: "preview",
    previewUrl: null,
  });
  expect(bob.state().remote).toEqual({
    phase: "requesting",
    sequence: 1,
    savedContact: false,
  });
  expect(alice.usage()).toEqual({ transmitted: 0, stopped: 0 });
  expect(bob.session.canReceive(camera(1))).toBe(false);
  bob.session.respond(1, "allow-always");
  expect(bob.state().remote.phase).toBe("requesting");
  bob.session.respond(1, "deny");
  await initial;
  expect(alice.usage()).toEqual({ transmitted: 0, stopped: 1 });
  expect(alice.state()).toMatchObject({
    local: { phase: "off" },
    error: "denied",
  });

  const outgoing = alice.session.enable();
  const incoming = bob.session.enable();
  await Bun.sleep(0);
  bob.session.respond(2, "allow-once");
  alice.session.respond(1, "allow-once");
  await Promise.all([outgoing, incoming]);
  expect(alice.state().remote.phase).toBe("authorized");
  expect(bob.state().remote.phase).toBe("authorized");
  expect(alice.usage().transmitted).toBe(1);
  expect(bob.usage().transmitted).toBe(1);
  alice.session.received(1, "bob");
  bob.session.received(2, "alice");
  alice.session.confirmFrames(camera(2));
  bob.session.confirmFrames(camera(1));
  expect(videoLayout(alice.state())).toEqual({
    source: "remote",
    stageUrl: "bob",
    previewUrl: "preview",
    mirrorLocal: true,
  });
  alice.session.swap();
  expect(videoLayout(alice.state())).toMatchObject({
    source: "local",
    stageUrl: "preview",
    previewUrl: "bob",
  });
  await alice.session.switchCamera();
  expect(videoLayout(alice.state()).mirrorLocal).toBe(false);
  alice.session.disable();
  expect(videoLayout(alice.state())).toMatchObject({
    source: "remote",
    stageUrl: "bob",
    previewUrl: null,
  });
  expect(bob.state().remote.phase).toBe("off");
  alice.session.interrupted(1);
  expect(videoLayout(alice.state()).stageUrl).toBeNull();
  alice.session.received(1, "bob");
  expect(videoLayout(alice.state()).stageUrl).toBe("bob");
  bob.session.disable();
  expect(videoLayout(alice.state()).stageUrl).toBeNull();
  alice.session.close();
  bob.session.close();
});

test("allow always is loaded by contact key on a later call; once stays within its session", async () => {
  using sqlite = new Database(":memory:");
  for (const sql of Object.values(migrations.migrations))
    for (const statement of sql.split("--> statement-breakpoint"))
      sqlite.exec(statement);
  const db = drizzle(sqlite);
  db.insert(contacts)
    .values([
      { publicKey: aliceKey, name: "Same name" },
      { publicKey: bobKey, name: "Same name" },
    ])
    .run();
  const preferences = (key: string) => ({
    policy: () => {
      const row = db
        .select()
        .from(contacts)
        .where(eq(contacts.publicKey, key))
        .get();
      return row
        ? row.allowIncomingVideo
          ? ("always" as const)
          : ("ask" as const)
        : ("unknown" as const);
    },
    allowAlways: () =>
      db
        .update(contacts)
        .set({ allowIncomingVideo: true })
        .where(eq(contacts.publicKey, key))
        .returning({ key: contacts.publicKey })
        .get()?.key === key,
  });
  const alice = device(() => bob.session);
  const bob = device(() => alice.session, preferences(aliceKey));
  const sending = alice.session.enable();
  await Bun.sleep(0);
  bob.session.respond(1, "allow-always");
  await sending;
  alice.session.close();
  bob.session.close();
  const later = device(() => alice.session, preferences(aliceKey));
  expect(await later.session.receiveOffer(offer(1))).toMatchObject({
    allowed: true,
  });
  expect(await later.session.receiveOffer(offer(1))).toMatchObject({
    allowed: false,
  });
  const separate = device(() => alice.session, preferences(bobKey));
  const pending = separate.session.receiveOffer(offer(1));
  expect(separate.state().remote.phase).toBe("requesting");
  separate.session.respond(1, "allow-once");
  expect(await pending).toMatchObject({ allowed: true });
  separate.session.receiveStop({ ...offer(1), type: "stop" });
  expect(await separate.session.receiveOffer(offer(2))).toMatchObject({
    allowed: true,
  });
  separate.session.close();
  const nextCall = device(() => alice.session, {
    ...preferences(bobKey),
    timeout: 1,
  });
  const expires = nextCall.session.receiveOffer(offer(1));
  expect(nextCall.state().remote.phase).toBe("requesting");
  expect(await expires).toMatchObject({ allowed: false });
  nextCall.session.respond(1, "allow-once");
  expect(nextCall.session.canReceive(camera(1))).toBe(false);
  expect(
    nextCall.session.receiveOffer({ ...offer(2), callId: bobKey }),
  ).toBeNull();
  later.session.close();
  nextCall.session.close();
});

test("late approvals and capture completion cannot revive a stopped camera", async () => {
  const startup = Promise.withResolvers<void>();
  const alice = device(() => bob.session, { startup: startup.promise });
  const bob = device(() => alice.session);
  const start = alice.session.enable();
  await Bun.sleep(0);
  alice.session.disable();
  startup.resolve();
  await start;
  expect(alice.usage()).toEqual({ transmitted: 0, stopped: 1 });
  const next = alice.session.enable();
  await Bun.sleep(0);
  alice.session.close();
  alice.session.close();
  bob.session.respond(2, "allow-once");
  await next;
  expect(alice.usage()).toEqual({ transmitted: 0, stopped: 2 });
  expect(bob.state().remote.phase).toBe("off");
  bob.session.close();
});

test("device permission or capture failure sends no video request", async () => {
  const bob = device(() => denied.session);
  const denied = device(() => bob.session, {
    captureFailure: "camera-permission",
  });
  const failed = device(() => bob.session, {
    captureFailure: "camera hardware in use",
  });
  await denied.session.enable();
  await failed.session.enable();
  expect(denied.state().error).toBe("permission");
  expect(failed.state().error).toBe("capture");
  expect(bob.state().remote.phase).toBe("off");
});

test("camera mutations wait for the other peer's SDP turn and release on call abort", async () => {
  const turns = createMediaTurns();
  const request = new AbortController();
  const call = new AbortController();
  expect(await turns.grant("first", request.signal, call.signal)).toBe(true);
  // Trystero ends the RPC context after sending the grant.
  request.abort();
  let started = false;
  const local = turns.enqueue(async () => {
    started = true;
  });
  await Bun.sleep(0);
  expect(started).toBe(false);
  turns.release("stale");
  expect(started).toBe(false);
  turns.release("first");
  await local;
  expect(started).toBe(true);
  expect(
    await turns.grant("last", new AbortController().signal, call.signal),
  ).toBe(true);
  const queued = turns.enqueue(async () => "released");
  call.abort();
  expect(await queued).toBe("released");
});
