import type { MediaStream as NativeStream } from "react-native-webrtc";
import type { Room } from "trystero";
import { z } from "zod";
import type { captureCamera } from "./camera";
import { watchedVideoLimit } from "./conference";
import { createMediaTurns, mediaTurn, mediaTurnTimeout } from "./media-turn";
import { opaqueId } from "./protocol";
import type {
  CameraFacing,
  VideoControls,
  VideoError,
  VideoState,
} from "./video";

const header = { version: z.literal(1), callId: opaqueId };
const availability = z.strictObject({
  ...header,
  sequence: z.number().int().nonnegative(),
  enabled: z.boolean(),
});
const watchRequest = z.strictObject({
  ...header,
  sequence: z.number().int().positive(),
  token: opaqueId,
  watching: z.boolean(),
});
const cameraStream = z.strictObject({
  ...header,
  kind: z.literal("conference-camera"),
  sequence: z.number().int().positive(),
  token: opaqueId,
});
type Capture = Awaited<ReturnType<typeof captureCamera>>;
type Watch = { token: string; sequence: number };
type Remote = {
  id: string;
  key: string;
  connection: RTCPeerConnection;
  signal: AbortSignal;
  turns: ReturnType<typeof createMediaTurns>;
  available: number;
  announced: number;
  watching?: Watch;
  outgoing?: {
    token: string;
    sequence: number;
    capture: Capture;
    attached: boolean;
  };
  stopFrames?: () => void;
  url?: string;
};

export function bindConferenceVideo({
  nativeStream,
  room,
  callId,
  signal,
  onVideo,
  openCamera,
  randomCallId,
  localKey,
}: {
  nativeStream: typeof import("react-native-webrtc").MediaStream;
  room: Pick<
    Room,
    "makeAction" | "addStream" | "removeStream" | "onPeerStream" | "getPeers"
  >;
  callId: string;
  signal: AbortSignal;
  onVideo: (state: VideoState | null) => void;
  openCamera: (operation: AbortSignal, onEnded: () => void) => Promise<Capture>;
  randomCallId: () => string;
  localKey: string;
}) {
  const cameraState = room.makeAction("boop-camv2");
  const watchAction = room.makeAction("boop-watch", { kind: "request" });
  const turnAction = room.makeAction("boop-vturn", { kind: "request" });
  const turnEnd = room.makeAction("boop-vdone");
  const remote = new Map<string, Remote>();
  const fields = { version: 1 as const, callId };
  let capture: Capture | undefined;
  let operation: AbortController | undefined;
  let capturing = Promise.resolve();
  let switching = false;
  let facing: CameraFacing = "front";
  let error: VideoError | null = null;
  let sequence = 0;
  let focus: string | null = null;
  let mode: "focus" | "grid" = "focus";
  let closed = false;
  const corner = { right: true, bottom: false };
  const current = (id: string) => {
    const peer = remote.get(id);
    return !closed &&
      peer &&
      !peer.signal.aborted &&
      room.getPeers()[id]?.connection === peer.connection
      ? peer
      : undefined;
  };

  function update() {
    if (closed) return;
    const peers = [...remote.values()];
    const selected =
      peers.find((peer) => peer.key === focus && peer.url) ??
      peers.find((peer) => peer.url);
    onVideo({
      local: capture
        ? {
            phase: peers.some((peer) => peer.outgoing?.attached)
              ? "sharing"
              : "preview",
            url: capture.url,
            facing,
          }
        : { phase: operation ? "starting" : "off" },
      remote: selected?.url
        ? {
            phase: "receiving",
            url: selected.url,
            sequence: selected.available,
          }
        : { phase: "off" },
      stage: "remote",
      corner,
      error,
      conference: {
        cameras: Object.fromEntries(
          peers
            .filter(({ available }) => available > 0)
            .map(({ key, watching, url }) => [
              key,
              { watching: !!watching, url },
            ]),
        ),
        focus: selected?.key ?? null,
        mode,
      },
    });
  }
  function announce(target: string | string[]) {
    return cameraState
      .send({ ...fields, sequence, enabled: !!capture }, { target, signal })
      .catch(() => undefined);
  }
  function resetWatch(peer: Remote) {
    peer.watching = undefined;
    peer.stopFrames?.();
    peer.stopFrames = undefined;
    peer.url = undefined;
  }
  function change(peer: Remote, apply: () => boolean | Promise<boolean>) {
    return peer.turns.enqueue(async () => {
      if (!current(peer.id)) return false;
      const turn = { ...fields, token: randomCallId() };
      const coordinator = localKey < peer.key;
      if (
        !coordinator &&
        (await turnAction.request(turn, {
          target: peer.id,
          timeoutMs: mediaTurnTimeout + 2_000,
          signal: peer.signal,
        })) !== true
      )
        throw new Error("Camera negotiation unavailable");
      try {
        const started = Date.now();
        const wait = async (ready: () => boolean) => {
          while (!ready()) {
            if (!current(peer.id) || Date.now() - started > mediaTurnTimeout)
              throw new Error("Camera negotiation timed out");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        };
        await wait(() => peer.connection.signalingState === "stable");
        if (!current(peer.id)) return false;
        const before = peer.connection.localDescription?.sdp;
        if (!(await apply())) return false;
        await wait(
          () =>
            peer.connection.signalingState === "stable" &&
            peer.connection.localDescription?.sdp !== before,
        );
        return true;
      } finally {
        if (!coordinator && current(peer.id))
          void turnEnd
            .send(turn, { target: peer.id, signal: peer.signal })
            .catch(() => undefined);
      }
    });
  }
  function stopSending(peer: Remote) {
    const previous = peer.outgoing;
    peer.outgoing = undefined;
    if (!previous) return Promise.resolve();
    return change(peer, () => {
      if (!previous.attached) return false;
      room.removeStream(previous.capture.stream, { target: peer.id });
      return true;
    }).then(
      () => undefined,
      () => undefined,
    );
  }
  function disable(reason: VideoError | null = null) {
    operation?.abort();
    operation = undefined;
    const previous = capture;
    capture = undefined;
    error = reason;
    if (previous) {
      sequence++;
      previous.stop();
      const removed = Promise.all([...remote.values()].map(stopSending));
      void removed.finally(previous.release);
      void announce([...remote.keys()]);
    }
    update();
  }
  async function enable() {
    if (operation || capture || closed) return;
    const pending = new AbortController();
    operation = pending;
    error = null;
    update();
    const work = capturing.then(async () => {
      pending.signal.throwIfAborted();
      const device = await openCamera(pending.signal, () => {
        if (operation === pending) disable("capture");
      });
      if (pending.signal.aborted) {
        device.stop();
        device.release();
        return;
      }
      capture = device;
      facing = "front";
      sequence++;
      await announce([...remote.keys()]);
      update();
    });
    capturing = work.catch(() => undefined);
    try {
      await work;
    } catch (failure) {
      if (operation === pending)
        disable(
          failure instanceof Error && failure.message === "camera-permission"
            ? "permission"
            : "capture",
        );
    }
  }
  const subscriptions = [
    cameraState.onMessage((input, { peerId }) => {
      const peer = current(peerId);
      const data = availability.safeParse(input).data;
      if (
        !peer ||
        !data ||
        data.callId !== callId ||
        data.sequence < peer.announced
      )
        return;
      const deadline = data.enabled ? data.sequence : 0;
      if (peer.announced === data.sequence && peer.available === deadline)
        return;
      peer.announced = data.sequence;
      peer.available = deadline;
      resetWatch(peer);
      update();
    }),
    watchAction.onRequest((input, { peerId }) => {
      const peer = current(peerId);
      const data = watchRequest.safeParse(input).data;
      if (!peer || !data || data.callId !== callId) return false;
      if (!data.watching)
        return peer.outgoing?.token === data.token &&
          peer.outgoing.sequence === data.sequence
          ? stopSending(peer).then(() => {
              update();
              return true;
            })
          : true;
      if (!capture || data.sequence !== sequence) return false;
      if (peer.outgoing?.token === data.token) return true;
      void stopSending(peer);
      const sending = {
        token: data.token,
        sequence,
        capture,
        attached: false,
      };
      peer.outgoing = sending;
      void change(peer, async () => {
        if (peer.outgoing !== sending || capture !== sending.capture)
          return false;
        sending.attached = true;
        await room.addStream(sending.capture.stream, {
          target: peer.id,
          metadata: {
            ...fields,
            kind: "conference-camera",
            token: sending.token,
            sequence: sending.sequence,
          },
        });
        update();
        return true;
      }).catch(() => {
        if (peer.outgoing === sending) {
          void stopSending(peer);
          error = "transmission";
          update();
        }
      });
      return true;
    }),
    turnAction.onRequest((data, context) => {
      const peer = current(context.peerId);
      const turn = mediaTurn.safeParse(data).data;
      return peer && localKey < peer.key && turn?.callId === callId
        ? peer.turns.grant(turn.token, context.signal, peer.signal)
        : false;
    }),
    turnEnd.onMessage((data, { peerId }) => {
      const turn = mediaTurn.safeParse(data).data;
      if (turn?.callId === callId) current(peerId)?.turns.release(turn.token);
    }),
    room.onPeerStream(
      (stream, { peerId, metadata }) => {
        if (!(stream instanceof nativeStream)) return;
        const track = stream.getVideoTracks()[0];
        if (!track) return;
        const peer = current(peerId);
        const frame = cameraStream.safeParse(metadata).data;
        if (
          !peer ||
          !frame ||
          frame.callId !== callId ||
          peer.watching?.token !== frame.token ||
          peer.watching.sequence !== frame.sequence
        ) {
          track.enabled = false;
          return;
        }
        peer.stopFrames?.();
        const receiver = peer.connection
          .getReceivers()
          .find(({ track: candidate }) => candidate?.id === track.id);
        if (!receiver) {
          track.enabled = false;
          return;
        }
        track.enabled = true;
        const url = (stream as unknown as NativeStream).toURL();
        let last = Date.now();
        let frames = 0;
        let sampling = false;
        let stopped = false;
        const timer = setInterval(() => {
          if (sampling) return;
          sampling = true;
          void receiver
            .getStats()
            .then((stats) => {
              if (
                stopped ||
                peer.watching?.token !== frame.token ||
                !current(peerId)
              )
                return;
              const count = [...stats.values()]
                .filter(
                  (value) =>
                    value.type === "inbound-rtp" && value.kind === "video",
                )
                .reduce(
                  (total, value) => total + (Number(value.framesDecoded) || 0),
                  0,
                );
              if (count > frames) {
                last = Date.now();
                if (peer.url !== url) {
                  peer.url = url;
                  update();
                }
              }
              frames = count;
            })
            .catch(() => undefined)
            .finally(() => {
              sampling = false;
              if (
                !stopped &&
                peer.url &&
                (track.readyState === "ended" || Date.now() - last > 2_500)
              ) {
                peer.url = undefined;
                update();
              }
            });
        }, 350);
        peer.stopFrames = () => {
          stopped = true;
          clearInterval(timer);
          track.enabled = false;
        };
      },
      { replay: true },
    ),
  ];
  const availabilityTimer = setInterval(() => {
    if (capture) void announce([...remote.keys()]);
  }, 6_000);
  async function cancelWatch(peer: Remote, token: Watch) {
    for (let attempt = 0; attempt < 3 && current(peer.id); attempt++) {
      if (
        (await watchAction
          .request(
            { ...fields, ...token, watching: false },
            {
              target: peer.id,
              timeoutMs: mediaTurnTimeout + 2_000,
              signal: peer.signal,
            },
          )
          .catch(() => false)) === true
      )
        return;
    }
  }
  update();
  return {
    add({
      id,
      key,
      connection,
      abort,
    }: {
      id: string;
      key: string;
      connection: RTCPeerConnection;
      abort: AbortController;
    }) {
      if (remote.has(id) || closed) return;
      remote.set(id, {
        id,
        key,
        connection,
        signal: abort.signal,
        turns: createMediaTurns(),
        available: 0,
        announced: 0,
      });
      if (capture) void announce(id);
      update();
    },
    remove(id: string) {
      const peer = remote.get(id);
      if (!peer) return;
      resetWatch(peer);
      remote.delete(id);
      update();
    },
    enable,
    disable: () => disable(),
    suspendCamera() {
      if (operation) disable("background");
    },
    async switchCamera() {
      const camera = capture;
      if (!camera || switching) return;
      switching = true;
      const next = facing === "front" ? "back" : "front";
      try {
        await camera.switchTo(next);
        if (camera === capture) facing = next;
      } catch {
        if (camera === capture) error = "switch";
      } finally {
        switching = false;
        update();
      }
    },
    async watch(key, watching) {
      const peer = [...remote.values()].find((item) => item.key === key);
      if (!peer || !current(peer.id)) return;
      const previous = peer.watching;
      if (!watching) {
        if (!previous) return;
        resetWatch(peer);
        update();
        await cancelWatch(peer, previous);
        return;
      }
      if (
        previous ||
        !peer.available ||
        [...remote.values()].filter((item) => item.watching).length >=
          watchedVideoLimit
      )
        return;
      const next = { token: randomCallId(), sequence: peer.available };
      peer.watching = next;
      error = null;
      update();
      const accepted = await watchAction
        .request(
          { ...fields, ...next, watching: true },
          { target: peer.id, timeoutMs: 3_500, signal: peer.signal },
        )
        .catch(() => false);
      if (!accepted && peer.watching === next) {
        resetWatch(peer);
        error = "transmission";
        update();
        void cancelWatch(peer, next);
      }
    },
    focus(key) {
      focus = key;
      update();
    },
    mode(next) {
      mode = next;
      update();
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(availabilityTimer);
      disable();
      for (const peer of remote.values()) resetWatch(peer);
      remote.clear();
      for (const unsubscribe of subscriptions) unsubscribe();
      onVideo(null);
    },
    // The existing one-to-one consent dialog and floating preview only apply there.
    respond() {},
    swap() {},
    setCorner() {},
  } satisfies VideoControls & {
    add(input: {
      id: string;
      key: string;
      connection: RTCPeerConnection;
      abort: AbortController;
    }): void;
    remove(id: string): void;
  };
}
