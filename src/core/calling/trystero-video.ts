import { Camera } from "expo-camera";
import { AppState } from "react-native";
import type { MediaStream as NativeStream } from "react-native-webrtc";
import type { Room } from "trystero";
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
  subscriptions.push(
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
      let permission = await Camera.getCameraPermissionsAsync();
      operation.throwIfAborted();
      if (!permission.granted && permission.canAskAgain) {
        onCameraPrompt(true);
        try {
          permission = await Camera.requestCameraPermissionsAsync();
          await waitForForeground(operation);
        } finally {
          onCameraPrompt(false);
        }
      }
      operation.throwIfAborted();
      if (!permission.granted) throw new Error("camera-permission");
      const constraints = { width: 640, height: 480, frameRate: 24 };
      const stream = await rtc.mediaDevices.getUserMedia({
        audio: false,
        video: { ...constraints, facingMode: "user" },
      });
      const track = stream.getVideoTracks()[0];
      if (!track || operation.aborted) {
        for (const track of stream.getTracks()) track.stop();
        stream.release();
        throw new Error("Camera unavailable");
      }
      track.onended = onEnded;
      const peerStream = stream as unknown as MediaStream;
      let attaching = false;
      return {
        url: stream.toURL(),
        async attach(metadata) {
          await changeCameraTracks(() => {
            if (!isDirect(peerId))
              throw new Error("Missing authenticated peer");
            attaching = true;
            return room.addStream(peerStream, { target: peerId, metadata });
          }, operation);
        },
        stop() {
          track.onended = null;
          track.enabled = false;
          track.stop();
          if (!attaching || signal.aborted || !isDirect(peerId)) {
            stream.release();
            return;
          }
          void changeCameraTracks(
            () => room.removeStream(peerStream, { target: peerId }),
            signal,
          )
            .catch(() => undefined)
            .finally(() => stream.release());
        },
        async switchTo(facing) {
          const facingMode = facing === "front" ? "user" : "environment";
          await track.applyConstraints({ ...constraints, facingMode });
          if (track.getSettings().facingMode !== facingMode)
            throw new Error("Requested camera unavailable");
        },
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
