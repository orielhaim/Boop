import { expect, test } from "bun:test";
import { bindConferenceVideo } from "../src/core/calling/conference-video";
import type { VideoState } from "../src/core/calling/video";

type MediaOptions = { target: string; metadata?: unknown };
type Handler = (
  input: unknown,
  context: { peerId: string; signal: AbortSignal },
) => unknown;
type PeerLink = { localDescription: { sdp: string }; signalingState: "stable" };
type Transport = Parameters<typeof bindConferenceVideo>[0];
const id = (n: number) => n.toString(16).padStart(64, "0");
const callId = id(123);

function testRoom() {
  const sent: { action: string; payload: unknown; target: unknown }[] = [];
  const added: [MediaStream, string, unknown][] = [];
  const removed: [MediaStream, string][] = [];
  const messages = new Map<string, Handler>();
  const requests = new Map<string, Handler>();
  const peers = new Map<string, { connection: PeerLink }>();
  let updates = 0;
  const fake = {
    makeAction(action: string) {
      function listen(handlers: Map<string, Handler>, handler: Handler) {
        handlers.set(action, handler);
        return () => handlers.delete(action);
      }
      return {
        onMessage: (handler: Handler) => listen(messages, handler),
        onRequest: (handler: Handler) => listen(requests, handler),
        async send(payload: unknown, options: MediaOptions) {
          sent.push({ action, payload, target: options.target });
        },
        async request(payload: unknown, options: MediaOptions) {
          sent.push({ action, payload, target: options.target });
          return true;
        },
      };
    },
    onPeerStream: () => () => undefined,
    async addStream(stream: MediaStream, { target, metadata }: MediaOptions) {
      added.push([stream, target, metadata]);
      changed(target);
    },
    removeStream(stream: MediaStream, { target }: MediaOptions) {
      removed.push([stream, target]);
      changed(target);
    },
    getPeers: () => Object.fromEntries(peers),
  };
  function changed(peer: string) {
    const link = peers.get(peer);
    if (link) link.connection.localDescription.sdp = String(++updates);
  }
  const control = new AbortController();
  const deliver = (
    handlers: Map<string, Handler>,
    action: string,
    input: unknown,
    peerId: string,
  ) => handlers.get(action)?.(input, { peerId, signal: control.signal });
  return {
    // This boundary replaces Trystero and WebRTC negotiation. The video controller runs unchanged.
    room: fake as unknown as Transport["room"],
    sent,
    added,
    removed,
    addPeer(peerId: string) {
      const connection: PeerLink = {
        localDescription: { sdp: "" },
        signalingState: "stable",
      };
      peers.set(peerId, { connection });
      return {
        id: peerId,
        connection: connection as unknown as RTCPeerConnection,
        abort: new AbortController(),
      };
    },
    message: (action: string, input: unknown, peerId: string) =>
      deliver(messages, action, input, peerId),
    request: (action: string, input: unknown, peerId: string) =>
      deliver(requests, action, input, peerId),
  };
}

test("selective camera uses one capture, sends only to viewers, and removes only the peer who stops", async () => {
  const fake = testRoom();
  class Stream {}
  const stream = new Stream() as unknown as MediaStream;
  let captures = 0;
  let releases = 0;
  let stops = 0;
  let latest: VideoState | null = null;
  let nonce = 100;
  const video = bindConferenceVideo({
    room: fake.room,
    nativeStream: Stream as unknown as Transport["nativeStream"],
    callId,
    signal: new AbortController().signal,
    localKey: id(1),
    randomCallId: () => id(nonce++),
    onVideo: (snapshot) => {
      latest = snapshot;
    },
    openCamera: async () => {
      captures++;
      return {
        stream,
        url: "camera:test",
        async switchTo() {},
        stop() {
          stops++;
        },
        release() {
          releases++;
        },
      };
    },
  });
  const fields = { version: 1, callId, sequence: 1 };
  const watching = { ...fields, token: id(50), watching: true };
  try {
    video.add({ key: id(2), ...fake.addPeer("first") });
    video.add({ key: id(3), ...fake.addPeer("second") });
    await video.enable();
    expect(fake.added).toEqual([]);
    expect(fake.sent).toEqual([
      {
        action: "boop-camv2",
        payload: { ...fields, enabled: true },
        target: ["first", "second"],
      },
    ]);
    expect(fake.request("boop-watch", watching, "unverified")).toBe(false);
    expect(
      fake.request("boop-watch", { ...watching, callId: id(600) }, "first"),
    ).toBe(false);
    expect(fake.request("boop-watch", watching, "first")).toBe(true);
    await Bun.sleep(0);
    expect(fake.added).toEqual([
      [
        stream,
        "first",
        { ...fields, kind: "conference-camera", token: id(50) },
      ],
    ]);
    fake.request("boop-watch", watching, "first");
    fake.request("boop-watch", { ...watching, token: id(51) }, "second");
    await Bun.sleep(0);
    expect(fake.added.map(([, target]) => target)).toEqual(["first", "second"]);
    expect(captures).toBe(1);
    await fake.request("boop-watch", { ...watching, watching: false }, "first");
    expect(fake.removed).toEqual([[stream, "first"]]);
    expect(stops).toBe(0);
    video.disable();
    await Bun.sleep(0);
    expect(fake.removed).toEqual([
      [stream, "first"],
      [stream, "second"],
    ]);
    expect(stops).toBe(1);
    expect(releases).toBe(1);
    expect(latest).toMatchObject({ local: { phase: "off" } });
  } finally {
    video.close();
  }
});

test("watching records consent before the request and layout changes send no control traffic", async () => {
  const fake = testRoom();
  class Stream {}
  const states: (VideoState | null)[] = [];
  const video = bindConferenceVideo({
    room: fake.room,
    callId,
    signal: new AbortController().signal,
    nativeStream: Stream as unknown as Transport["nativeStream"],
    localKey: id(1),
    randomCallId: () => id(93),
    onVideo: (state) => states.push(state),
    openCamera: async () => {
      throw new Error("Must not open a camera to watch");
    },
  });
  try {
    const member = id(2);
    video.add({ key: member, ...fake.addPeer("camera") });
    fake.message(
      "boop-camv2",
      { version: 1, callId, sequence: 1, enabled: true },
      "camera",
    );
    expect(fake.sent).toEqual([]);
    expect(states.at(-1)?.conference?.cameras[member]?.watching).toBe(false);
    await video.watch(member, true);
    expect(states.at(-1)?.conference?.cameras[member]?.watching).toBe(true);
    video.mode("grid");
    video.focus(member);
    expect(fake.sent).toHaveLength(1);
    await video.watch(member, false);
    expect(states.at(-1)?.conference?.cameras[member]?.watching).toBe(false);
    expect(fake.sent).toMatchObject([
      {
        action: "boop-watch",
        target: "camera",
        payload: { token: id(93), watching: true },
      },
      {
        action: "boop-watch",
        target: "camera",
        payload: { token: id(93), watching: false },
      },
    ]);
  } finally {
    video.close();
  }
});
