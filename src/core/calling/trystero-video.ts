import type { Room } from "@trystero-p2p/core";
import { AppState } from "react-native";
import type { MediaStream as NativeStream } from "react-native-webrtc";
import { captureCamera } from "./camera";
import { createMediaTurns, mediaTurn, mediaTurnTimeout } from "./media-turn";
import {
  cameraMetadata,
  consentTimeout,
  createVideoSession,
  type VideoState,
} from "./video";

export function bindTrysteroVideo({
  rtc,
  room,
  connection,
  callId,
  coordinator,
  peerId,
  signal,
  subscriptions,
  turnSubscriptions,
  isDirect,
  randomCallId,
  waitForForeground,
  onCameraPrompt,
  onVideo,
  getPolicy,
  allowAlways,
}: {
  rtc: typeof import("react-native-webrtc");
  room: Room;
  connection: RTCPeerConnection;
  callId: string;
  coordinator: boolean;
  peerId: string;
  signal: AbortSignal;
  subscriptions: (() => void)[];
  turnSubscriptions: (() => void)[];
  isDirect: (id: string) => boolean;
  randomCallId: () => string;
  waitForForeground: (signal: AbortSignal) => Promise<void>;
  onCameraPrompt: (open: boolean) => void;
  onVideo: (video: VideoState | null) => void;
  getPolicy: () => "unknown" | "ask" | "always";
  allowAlways: () => boolean;
}) {
  const videoOffers = room.makeAction("boop-video", { kind: "request" });
  const videoStops = room.makeAction("boop-camstop");
  const videoFrames = room.makeAction("boop-frame");
  const turnRequest = room.makeAction("boop-turn", { kind: "request" });
  const turnRelease = room.makeAction("boop-turnend");
  const turns = createMediaTurns();
  turnSubscriptions.push(
    turnRequest.onRequest((data, context) => {
      const turn = mediaTurn.safeParse(data).data;
      return turn &&
        turn.callId === callId &&
        coordinator &&
        isDirect(context.peerId)
        ? turns.grant(turn.token, context.signal, signal)
        : false;
    }),
    turnRelease.onMessage((data, context) => {
      const turn = mediaTurn.safeParse(data).data;
      if (
        turn &&
        turn.callId === callId &&
        coordinator &&
        isDirect(context.peerId)
      )
        turns.release(turn.token);
    }),
  );
  function changeCameraTracks(
    change: () => void | Promise<void>,
    operation: AbortSignal,
  ) {
    return turns.enqueue(async () => {
      operation.throwIfAborted();
      signal.throwIfAborted();
      const turn = { version: 1, callId, token: randomCallId() };
      if (
        !coordinator &&
        (await turnRequest.request(turn, {
          target: peerId,
          timeoutMs: mediaTurnTimeout + 2_000,
          signal,
        })) !== true
      )
        throw new Error("Camera negotiation unavailable");
      try {
        const deadline = Date.now() + mediaTurnTimeout;
        while (connection.signalingState !== "stable") {
          if (Date.now() >= deadline)
            throw new Error("Unstable camera connection");
          signal.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        operation.throwIfAborted();
        const before = connection.localDescription?.sdp;
        await change();
        // addStream and removeStream return before Trystero finishes SDP negotiation.
        while (
          connection.signalingState !== "stable" ||
          connection.localDescription?.sdp === before
        ) {
          signal.throwIfAborted();
          if (Date.now() >= deadline)
            throw new Error("Camera negotiation timed out");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        if (!coordinator && isDirect(peerId))
          void turnRelease
            .send(turn, { target: peerId, signal })
            .catch(() => undefined);
      }
    });
  }
  let clearRemoteCamera: (() => void) | undefined;
  let clearRemoteCameraIfObsolete: (() => void) | undefined;
  const currentVideo = createVideoSession({
    callId,
    capture: async (operation, onEnded) => {
      const capture = await captureCamera({
        rtc,
        operation,
        onEnded,
        onCameraPrompt,
        waitForForeground,
      });
      const peerStream = capture.stream;
      let attaching = false;
      return {
        url: capture.url,
        async attach(metadata) {
          await changeCameraTracks(() => {
            if (!isDirect(peerId))
              throw new Error("Missing authenticated peer");
            attaching = true;
            return room.addStream(peerStream, { target: peerId, metadata });
          }, operation);
        },
        stop() {
          capture.stop();
          if (!attaching || signal.aborted || !isDirect(peerId)) {
            capture.release();
            return;
          }
          void changeCameraTracks(
            () => room.removeStream(peerStream, { target: peerId }),
            signal,
          )
            .catch(() => undefined)
            .finally(() => capture.release());
        },
        switchTo: capture.switchTo,
      };
    },
    offer: (data, operation) =>
      videoOffers.request(data, {
        target: peerId,
        signal: operation,
        timeoutMs: consentTimeout + 2_000,
      }),
    stop: (data) => {
      if (isDirect(peerId))
        void videoStops
          .send(data, { target: peerId, signal })
          .catch(() => undefined);
    },
    policy: getPolicy,
    allowAlways,
    foreground: () => AppState.currentState === "active",
    update: onVideo,
  });
  subscriptions.push(
    videoOffers.onRequest((data, context) => {
      if (!isDirect(context.peerId)) return null;
      return currentVideo.receiveOffer(data, context.signal);
    }),
    videoStops.onMessage((data, context) => {
      if (isDirect(context.peerId)) {
        currentVideo.receiveStop(data);
        clearRemoteCameraIfObsolete?.();
      }
    }),
    videoFrames.onMessage((data, context) => {
      if (isDirect(context.peerId)) currentVideo.confirmFrames(data);
    }),
    room.onPeerStream((incoming, context) => {
      if (!(incoming instanceof rtc.MediaStream)) return;
      const track = incoming.getVideoTracks()[0];
      if (!track) return;
      const metadata = cameraMetadata.safeParse(context.metadata).data;
      if (
        !isDirect(context.peerId) ||
        !metadata ||
        !currentVideo.canReceive(metadata)
      ) {
        track.enabled = false;
        return;
      }
      const { sequence } = metadata;
      const frameMetadata = metadata;
      const url = (incoming as unknown as NativeStream).toURL();
      clearRemoteCamera?.();
      track.enabled = true;
      const receiver = connection
        .getReceivers()
        .find((item) => item.track?.id === track.id);
      if (!receiver) return;
      let reading = false;
      let stopped = false;
      let acknowledged = false;
      let frames = 0;
      let lastFrame = Date.now();
      async function checkFrames() {
        if (reading || stopped) return;
        if (
          !currentVideo.canReceive(metadata) ||
          track.readyState === "ended"
        ) {
          clear();
          return;
        }
        reading = true;
        try {
          const stats = await receiver?.getStats();
          if (stopped || !currentVideo.canReceive(metadata)) return;
          for (const report of stats?.values() ?? []) {
            if (report.type !== "inbound-rtp" || report.kind !== "video")
              continue;
            const decoded = Number(report.framesDecoded) || 0;
            if (decoded > frames) {
              lastFrame = Date.now();
              currentVideo.received(sequence, url);
              if (!acknowledged) {
                acknowledged = true;
                void videoFrames
                  .send(frameMetadata, { target: peerId, signal })
                  .catch(() => {
                    acknowledged = false;
                  });
              }
            }
            frames = decoded;
          }
        } catch {
          // Native stats can be unavailable during stream removal.
        } finally {
          reading = false;
          if (!stopped && Date.now() - lastFrame > 2_500)
            currentVideo.interrupted(sequence);
        }
      }
      const interval = setInterval(() => void checkFrames(), 400);
      function clear() {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        track.enabled = false;
        currentVideo.interrupted(sequence);
      }
      clearRemoteCamera = clear;
      clearRemoteCameraIfObsolete = () => {
        if (!currentVideo.canReceive(metadata)) clear();
      };
      void checkFrames();
    }),
    () => clearRemoteCamera?.(),
  );
  currentVideo.initialize();
  return currentVideo;
}
