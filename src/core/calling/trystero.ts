import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk";
import { getRandomValues, randomUUID } from "expo-crypto";
import { AppState } from "react-native";
import type { MediaStream as NativeStream } from "react-native-webrtc";
import type { OpenMedia } from "./controller";
import { openCallAudio } from "./native-audio";
import { askForMicrophone, hasMicrophonePermission } from "./permissions";
import {
  opaqueId,
  peerTranscript,
  proofKind,
  verifyPeerProof,
} from "./protocol";

export function randomCallId() {
  const bytes = getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

let runtime: ReturnType<typeof initialize> | undefined;
export function initializeCallingRuntime() {
  runtime ??= initialize().catch((error) => {
    runtime = undefined;
    throw error;
  });
  return runtime;
}

async function initialize() {
  const rtc = await import("react-native-webrtc");
  rtc.registerGlobals();
  if (!globalThis.crypto?.subtle) {
    const { subtle } = await import("react-native-quick-crypto");
    Object.defineProperty(globalThis.crypto, "subtle", { value: subtle });
  }
  if (!globalThis.crypto.randomUUID) {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: randomUUID,
    });
  }
  if (!Promise.withResolvers) {
    // React Native's Promise polyfill can replace the Hermes implementation.
    Object.defineProperty(Promise, "withResolvers", {
      value: function withResolvers<T>(this: PromiseConstructor) {
        let resolve!: PromiseWithResolvers<T>["resolve"];
        let reject!: PromiseWithResolvers<T>["reject"];
        const promise = new this<T>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        return { promise, resolve, reject };
      },
    });
  }
  if (typeof globalThis.addEventListener !== "function") {
    // Trystero registers browser unload hooks because React Native exposes
    // window. AppState and the controller own native teardown.
    const events = new EventTarget();
    Object.defineProperties(globalThis, {
      addEventListener: { value: events.addEventListener.bind(events) },
      removeEventListener: { value: events.removeEventListener.bind(events) },
    });
  }
  const { joinRoom } = await import("trystero");
  return { ...rtc, joinRoom };
}

function pending<T>(
  signal: AbortSignal,
  execute: (
    resolve: (value: T) => void,
    reject: (error: Error) => void,
  ) => void,
) {
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => reject(new Error("Call ended"));
    signal.addEventListener("abort", abort, { once: true });
    const complete = () => signal.removeEventListener("abort", abort);
    execute(
      (value) => {
        complete();
        resolve(value);
      },
      (error) => {
        complete();
        reject(error);
      },
    );
  });
}

function stableSignaling(connection: RTCPeerConnection, signal: AbortSignal) {
  return pending<void>(signal, (resolve) => {
    const dispose = () =>
      connection.removeEventListener("signalingstatechange", check);
    const check = () => {
      if (connection.signalingState !== "stable") return;
      dispose();
      signal.removeEventListener("abort", dispose);
      resolve();
    };
    connection.addEventListener("signalingstatechange", check);
    signal.addEventListener("abort", dispose, { once: true });
    check();
  });
}

async function requestMicrophone(
  signal: AbortSignal,
  onPrompt: (open: boolean) => void,
) {
  if (await hasMicrophonePermission()) return;
  signal.throwIfAborted();
  onPrompt(true);
  try {
    if (!(await askForMicrophone())) throw new Error("microphone-permission");
    signal.throwIfAborted();
    if (AppState.currentState !== "active") {
      await pending<void>(signal, (resolve) => {
        const subscription = AppState.addEventListener("change", (state) => {
          if (state !== "active") return;
          signal.removeEventListener("abort", dispose);
          dispose();
          resolve();
        });
        const dispose = () => subscription.remove();
        signal.addEventListener("abort", dispose, { once: true });
      });
    }
  } finally {
    onPrompt(false);
  }
}

export function trysteroMedia(signer: NDKSigner): OpenMedia {
  const localKey = signer.userSync.pubkey;
  return async ({
    invite,
    peerKey,
    signal,
    acceptance,
    onDisconnect,
    onHangup,
    onReconnecting,
    onRouting,
    onMicrophonePrompt,
  }) => {
    const rtc = await initializeCallingRuntime();
    signal.throwIfAborted();
    const room = rtc.joinRoom(
      {
        appId: "app.boop.mobile.voice.v1",
        password: invite.roomSecret,
        identity: "none",
        maxUsers: 2,
        relayConfig: { warnOnRelayFailure: false },
      },
      invite.roomId,
    );
    let localStream: NativeStream | undefined;
    let audio: ReturnType<typeof openCallAudio> | undefined;
    let closed = false;
    const subscriptions: (() => void)[] = [];
    function close() {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", close);
      for (const unsubscribe of subscriptions) unsubscribe();
      for (const track of localStream?.getTracks() ?? []) track.stop();
      audio?.close();
      void room.leave().catch(() => undefined);
    }
    signal.addEventListener("abort", close, { once: true });
    try {
      const { peerId: selfId } = await room.getSelf();
      signal.throwIfAborted();
      const exchange = room.makeAction<string, string>("boop-proof", {
        kind: "request",
      });
      const hangup = room.makeAction<string>("boop-end");
      const confirmMedia = room.makeAction<string>("boop-media");
      function transcript(remote: string, challenge: string, signing: boolean) {
        const connection = room.getPeers()[remote]?.connection;
        if (!connection) throw new Error("Missing direct connection");
        const local = {
          id: selfId,
          key: localKey,
          sdp: connection.localDescription?.sdp,
        };
        const peer = {
          id: remote,
          key: peerKey,
          sdp: connection.remoteDescription?.sdp,
        };
        return peerTranscript({
          callId: invite.callId,
          roomId: invite.roomId,
          challenge,
          sender: signing ? local : peer,
          recipient: signing ? peer : local,
        });
      }
      subscriptions.push(
        exchange.onRequest(async (data, context) => {
          const challenge = opaqueId.parse(data);
          const proof = new NDKEvent(undefined);
          proof.kind = proofKind;
          proof.content = transcript(context.peerId, challenge, true);
          await proof.sign(signer);
          signal.throwIfAborted();
          return JSON.stringify(proof.rawEvent());
        }),
      );
      let authenticated: string | undefined;
      let peerReady = false;
      let confirmReady: (() => void) | undefined;
      subscriptions.push(
        confirmMedia.onMessage((data, context) => {
          if (data !== "ready" || authenticated !== context.peerId) return;
          peerReady = true;
          confirmReady?.();
        }),
      );
      subscriptions.push(
        hangup.onMessage((data, context) => {
          if (data === "end" && authenticated === context.peerId) onHangup();
        }),
      );
      const remoteAudio = new Map<string, MediaStream>();
      let remoteReady: (() => void) | undefined;
      subscriptions.push(
        room.onPeerStream((stream, context) => {
          const valid = authenticated === context.peerId;
          const tracks = stream.getAudioTracks();
          for (const track of tracks) track.enabled = valid;
          if (!tracks.some((track) => track.readyState === "live")) return;
          remoteAudio.set(context.peerId, stream);
          if (valid) remoteReady?.();
        }),
      );
      const peerId = await pending<string>(signal, (resolve) => {
        subscriptions.push(room.onPeerJoin(({ peerId }) => resolve(peerId)));
        const existing = Object.keys(room.getPeers())[0];
        if (existing) resolve(existing);
      });
      subscriptions.push(
        room.onPeerLeave((event) => {
          if (event.peerId === peerId) onDisconnect();
        }),
      );
      subscriptions.push(
        room.onPeerJoin((event) => {
          if (event.peerId !== peerId)
            room.getPeers()[event.peerId]?.connection?.close();
        }),
      );
      const challenge = randomCallId();
      const expected = transcript(peerId, challenge, false);
      const raw = await exchange.request(challenge, {
        target: peerId,
        timeoutMs: 8_000,
        signal,
      });
      if (
        typeof raw !== "string" ||
        raw.length > 4096 ||
        !verifyPeerProof(
          JSON.parse(raw),
          expected,
          peerKey,
          Math.floor(Date.now() / 1_000),
        ) ||
        transcript(peerId, challenge, false) !== expected
      )
        throw new Error("The peer did not prove its identity");
      // Overlap room setup and peer proof with acceptance publication.
      // Capture and playback still wait for acceptance and verified identity.
      if (!(await acceptance)) throw new Error("Acceptance was not published");
      signal.throwIfAborted();
      authenticated = peerId;
      const connection = room.getPeers()[peerId]?.connection;
      if (!connection) throw new Error("Missing direct connection");
      const handleIce = () =>
        onReconnecting(connection.iceConnectionState === "disconnected");
      connection.addEventListener("iceconnectionstatechange", handleIce);
      subscriptions.push(() =>
        connection.removeEventListener("iceconnectionstatechange", handleIce),
      );
      await requestMicrophone(signal, onMicrophonePrompt);
      signal.throwIfAborted();
      audio = openCallAudio(onRouting, onDisconnect);
      let captured: NativeStream;
      try {
        captured = await rtc.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      } catch {
        throw new Error("microphone-permission");
      }
      if (signal.aborted) {
        for (const track of captured.getTracks()) track.stop();
        signal.throwIfAborted();
      }
      localStream = captured;
      const tracks = captured.getAudioTracks();
      if (!tracks.length) throw new Error("No microphone");
      for (const track of tracks) track.onended = onDisconnect;
      const remote = pending<void>(signal, (resolve) => {
        remoteReady = () => resolve();
        const stream = remoteAudio.get(peerId);
        if (stream) {
          stream.getAudioTracks().forEach((track) => {
            track.enabled = true;
          });
          resolve();
        }
      });
      // The installed native stream implements the operations Trystero calls,
      // but does not declare the complete browser MediaStream interface.
      const attach = () =>
        room.addStream(captured as unknown as MediaStream, { target: peerId });
      if (invite.senderKey === localKey) {
        await Promise.all([remote, attach()]);
      } else {
        // Outbound and inbound offers can collide if both RN peers add tracks together.
        await remote;
        await stableSignaling(connection, signal);
        signal.throwIfAborted();
        await attach();
      }
      await Promise.all([
        confirmMedia.send("ready", { target: peerId, signal }),
        pending<void>(signal, (resolve) => {
          if (peerReady) resolve();
          else confirmReady = () => resolve();
        }),
      ]);
      signal.throwIfAborted();
      return {
        close,
        notifyHangup: () => hangup.send("end", { target: peerId }),
        async inspect() {
          const stats = await connection.getStats();
          let sentPackets = 0;
          let receivedPackets = 0;
          for (const value of stats.values()) {
            if (value.kind !== "audio") continue;
            if (value.type === "outbound-rtp")
              sentPackets += Number(value.packetsSent) || 0;
            if (value.type === "inbound-rtp")
              receivedPackets += Number(value.packetsReceived) || 0;
          }
          return {
            ice: connection.iceConnectionState,
            microphone: tracks.some(
              (track) => track.enabled && track.readyState === "live",
            ),
            remoteTrack:
              remoteAudio
                .get(peerId)
                ?.getAudioTracks()
                .some((track) => track.readyState === "live") ?? false,
            sentPackets,
            receivedPackets,
          };
        },
        mute: (muted) => {
          for (const track of tracks) track.enabled = !muted;
        },
        route: async (value) => audio?.route(value),
      };
    } catch (error) {
      close();
      throw error;
    }
  };
}
