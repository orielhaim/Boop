import { NDKEvent, type NDKSigner } from "@nostr-dev-kit/ndk";
import { getRandomValues, randomUUID } from "expo-crypto";
import { AppState, Platform } from "react-native";
import type {
  MediaStream as NativeStream,
  MediaStreamTrack as NativeTrack,
} from "react-native-webrtc";
import { z } from "zod";
import { publicKeySchema } from "../identity/keys";
import { captureCamera } from "./camera";
import {
  admission,
  callCapacity,
  reservationRequest,
  type ParticipantVolume,
} from "./conference";
import { bindConferenceVideo } from "./conference-video";
import type { OpenMedia } from "./controller";
import { callMetric, traceAudioPackets } from "./diagnostics";
import { directSignaling } from "./direct-signaling";
import { openCallAudio } from "./native-audio";
import { askForMicrophone, hasMicrophonePermission } from "./permissions";
import {
  opaqueId,
  peerTranscript,
  proofKind,
  verifyPeerProof,
} from "./protocol";
import type { InviteDraft, RtcSignal } from "./signals";
import { bindTrysteroVideo } from "./trystero-video";
import type { VideoControls } from "./video";

const proofKey = z.object({ pubkey: publicKeySchema });
const proofRequest = z.strictObject({
  key: publicKeySchema,
  challenge: opaqueId,
});

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
  // Keep the native calling graph in Metro's main bundle and evaluate it on
  // demand. Lazy chunks failed to load dependencies on Android dev clients.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rtc: typeof import("react-native-webrtc") = require("react-native-webrtc");
  rtc.registerGlobals();
  if (!globalThis.crypto?.subtle) {
    const crypto: typeof import("react-native-quick-crypto") =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("react-native-quick-crypto");
    Object.defineProperty(globalThis.crypto, "subtle", {
      value: crypto.subtle,
    });
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const core: typeof import("@trystero-p2p/core") = require("@trystero-p2p/core");
  return { ...rtc, core };
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

function waitForForeground(signal: AbortSignal) {
  if (AppState.currentState === "active") return Promise.resolve();
  return pending<void>(signal, (resolve) => {
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
    await waitForForeground(signal);
  } finally {
    onPrompt(false);
  }
}

export function trysteroMedia(
  signer: NDKSigner,
  videoPolicy: {
    get: (peerKey: string) => "unknown" | "ask" | "always";
    allow: (peerKey: string) => boolean;
  },
  openSystemAudio: (
    options: Pick<
      Parameters<OpenMedia>[0],
      "invite" | "peerKey" | "signal" | "onRouting"
    >,
  ) => Promise<ReturnType<typeof openCallAudio> | null>,
  publish: Parameters<typeof directSignaling>[0]["publish"],
  isBlocked = (_key: string) => false,
) {
  const localKey = signer.userSync.pubkey;
  function setup(invite: InviteDraft, signal: AbortSignal) {
    return initializeCallingRuntime().then((rtc) => {
      signal.throwIfAborted();
      callMetric("room_initialization_started");
      const signaling = directSignaling({
        invite,
        localKey,
        signal,
        randomId: randomCallId,
        publish,
      });
      const authorized = new WeakMap<RTCPeerConnection, MediaStreamTrack>();
      const room = rtc.core.createStrategy(signaling.adapter)(
        {
          appId: "app.boop.mobile.voice.direct",
          identity: "none",
          maxUsers: callCapacity,
          passive: true,
          preparePeerConnection(connection, initiator) {
            connection.addEventListener("track", ({ track }) => {
              if (
                track.kind === "audio" &&
                authorized.get(connection) !== track
              )
                track.enabled = false;
            });
            if (initiator)
              connection.addTransceiver("audio", { direction: "sendrecv" });
            if (__DEV__) {
              connection.addEventListener("icegatheringstatechange", () =>
                callMetric("ice_gathering", {
                  state: connection.iceGatheringState,
                }),
              );
              connection.addEventListener("iceconnectionstatechange", () =>
                callMetric("ice_state", {
                  state: connection.iceConnectionState,
                }),
              );
              connection.addEventListener("connectionstatechange", () =>
                callMetric("peer_connection_state", {
                  state: connection.connectionState,
                }),
              );
            }
          },
          prepareInitialAnswer(connection) {
            const audio = connection
              .getTransceivers()
              .find(({ receiver }) => receiver.track?.kind === "audio");
            if (!audio) throw new Error("Offer has no audio transceiver");
            audio.direction = "sendrecv";
          },
        },
        invite.roomId,
      );
      let roomClosed = false;
      const closeRoom = () => {
        if (roomClosed) return;
        roomClosed = true;
        signal.removeEventListener("abort", closeRoom);
        signaling.close();
        void room.leave().catch(() => undefined);
      };
      signal.addEventListener("abort", closeRoom, { once: true });
      return { rtc, room, signaling, authorized, closeRoom };
    });
  }
  let current:
    | { id: string; signal: AbortSignal; ready: ReturnType<typeof setup> }
    | undefined;
  function session(invite: InviteDraft, signal: AbortSignal) {
    if (current?.signal === signal) return current.ready;
    const ready = setup(invite, signal);
    current = { id: invite.callId, signal, ready };
    signal.addEventListener(
      "abort",
      () => {
        if (current?.signal === signal) current = undefined;
      },
      { once: true },
    );
    return ready;
  }
  const open: OpenMedia = async ({
    invite,
    peerKey,
    signal,
    acceptance,
    authorizePeers,
    onDisconnect,
    onHangup,
    onRemoteMute,
    onReconnecting,
    onRouting,
    onMicrophonePrompt,
    onCameraPrompt,
    onAuthenticated,
    onParticipants,
    onVideo,
  }) => {
    const { rtc, room, signaling, authorized, closeRoom } = await session(
      invite,
      signal,
    );
    signal.throwIfAborted();
    type Link = {
      id: string;
      key: string;
      connection: RTCPeerConnection;
      abort: AbortController;
      audio: MediaStreamTrack;
      wake?: () => void;
      confirmed: boolean;
      mediaReady: boolean;
      ready: boolean;
      seatId?: string;
      started: number;
      muted: boolean;
      silenced: boolean;
      volume: ParticipantVolume;
      speaking: boolean;
      speakingUntil: number;
      iceListener?: () => void;
    };
    const links = new Map<string, Link>();
    const handshakes = new Map<string, AbortController>();
    const initial = new Set(invite.conference?.roster ?? [peerKey]);
    const members = () => [...links.values()].filter((link) => link.ready);
    const reservations = admission({
      localKey,
      callId: invite.callId,
      connected: () => members().map(({ key }) => key),
      isBlocked,
    });
    let localStream: NativeStream | undefined;
    let audio: ReturnType<typeof openCallAudio> | undefined;
    let video: VideoControls | undefined;
    let conferenceVideo: ReturnType<typeof bindConferenceVideo> | undefined;
    let grouped = !!invite.conference;
    let muted = false;
    let closed = false;
    let hasAudio = false;
    let activateAudio: (() => void) | undefined;
    let firstAudio: (() => void) | undefined;
    let startMedia: (() => void) | undefined;
    const subscriptions: (() => void)[] = [];
    const videoSubscriptions: (() => void)[] = [];
    const recovering = new Map<
      string,
      {
        expiresAt: number;
        deadline: ReturnType<typeof setTimeout>;
        retries: ReturnType<typeof setTimeout>[];
        silenced: boolean;
        volume: ParticipantVolume;
      }
    >();
    function stopRecovery(key: string) {
      const attempt = recovering.get(key);
      if (!attempt) return;
      recovering.delete(key);
      clearTimeout(attempt.deadline);
      for (const timer of attempt.retries) clearTimeout(timer);
    }
    const stopSoloVideo = () => {
      video?.close();
      video = undefined;
      for (const unsubscribe of videoSubscriptions.splice(0)) unsubscribe();
    };
    function close() {
      if (closed) return;
      closed = true;
      stopSoloVideo();
      conferenceVideo?.close();
      signal.removeEventListener("abort", close);
      for (const abort of handshakes.values()) abort.abort();
      for (const key of recovering.keys()) stopRecovery(key);
      for (const link of links.values()) {
        link.abort.abort();
        link.iceListener?.();
        link.audio.enabled = false;
      }
      for (const unsubscribe of subscriptions) unsubscribe();
      for (const track of localStream?.getTracks() ?? []) track.stop();
      localStream?.release();
      audio?.close();
      closeRoom();
    }
    signal.addEventListener("abort", close, { once: true });
    try {
      const { peerId: selfId } = await room.getSelf();
      signal.throwIfAborted();
      const exchange = room.makeAction<string, string>("boop-proof", {
        kind: "request",
      });
      const hangup = room.makeAction<string>("boop-end");
      const muteState = room.makeAction<boolean>("boop-mute");
      const confirmMedia = room.makeAction<string>("boop-media");
      const reserve = room.makeAction("boop-seat", { kind: "request" });
      const grant = room.makeAction("boop-grant", { kind: "request" });
      const admit = room.makeAction<string, boolean>("boop-admit", {
        kind: "request",
      });
      const release = room.makeAction<string>("boop-unseat");
      subscriptions.push(
        room.onError(({ code, cause }) =>
          callMetric("trystero_room_error", {
            code,
            error: cause instanceof Error ? cause.name : "unknown",
          }),
        ),
      );
      const isDirect = (id: string) => {
        const link = links.get(id);
        return (
          !closed &&
          !!link &&
          !link.abort.signal.aborted &&
          room.getPeers()[id]?.connection === link.connection
        );
      };
      const isMember = (id: string) =>
        isDirect(id) && links.get(id)?.ready === true;
      const eligible = (key: string) =>
        !isBlocked(key) &&
        (initial.has(key) || reservations.permits(key) || recovering.has(key));
      const initialScope = {
        invitationId: invite.conference?.id,
        expiresAt: invite.expiresAt,
      };

      function transcript(
        link: Pick<Link, "id" | "key" | "connection">,
        challenge: string,
        signing: boolean,
      ) {
        const local = {
          id: selfId,
          key: localKey,
          sdp: link.connection.localDescription?.sdp,
        };
        const peer = {
          id: link.id,
          key: link.key,
          sdp: link.connection.remoteDescription?.sdp,
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
          if (typeof data !== "string" || data.length > 256) return "";
          const request = proofRequest.safeParse(JSON.parse(data)).data;
          if (
            !request ||
            !eligible(request.key) ||
            !signaling.matches(request.key, context.peerId)
          )
            return "";
          const connection = room.getPeers()[context.peerId]?.connection;
          if (!connection) return "";
          const proof = new NDKEvent(undefined);
          proof.kind = proofKind;
          proof.content = transcript(
            { id: context.peerId, key: request.key, connection },
            request.challenge,
            true,
          );
          await proof.sign(signer);
          signal.throwIfAborted();
          return JSON.stringify(proof.rawEvent());
        }),
      );

      function showParticipants() {
        onParticipants?.(
          members().map(({ key, muted, silenced, volume, speaking }) => ({
            key,
            muted,
            silenced,
            volume,
            speaking,
          })),
        );
      }
      const notifyHangup = () =>
        hangup.send("end", { target: [...links.keys()] });
      const firstProof = pending<void>(signal, (resolve) => {
        activateAudio = () => resolve();
      });
      const firstMedia = pending<void>(signal, (resolve) => {
        firstAudio = () => resolve();
      });
      void firstMedia.catch(() => undefined);
      let fullRoster: (() => void) | undefined;
      const rosterMedia =
        invite.conference &&
        pending<void>(signal, (resolve) => {
          fullRoster = () => resolve();
        });
      void rosterMedia?.catch(() => undefined);
      let joiningConference = !!invite.conference;
      const audioReady = pending<void>(signal, (resolve) => {
        startMedia = () => resolve();
      });
      void audioReady.catch(() => undefined);
      function leave(id: string, graceful: boolean) {
        handshakes.get(id)?.abort();
        handshakes.delete(id);
        const link = links.get(id);
        if (!link) return;
        links.delete(id);
        signaling.remove(link.key);
        link.abort.abort();
        link.iceListener?.();
        authorized.delete(link.connection);
        link.audio.enabled = false;
        conferenceVideo?.remove(id);
        if (id === soloId) stopSoloVideo();
        if (!link.ready) {
          if (joiningConference && initial.has(link.key)) onDisconnect();
          return;
        }
        initial.delete(link.key);
        if (!graceful && hasAudio && !closed) recover(link);
        showParticipants();
        refreshIce();
        if (!hasAudio || members().length) return;
        if (graceful) onHangup();
        else if (!recovering.size) onDisconnect();
      }
      function refreshIce() {
        const current = members();
        onReconnecting(
          current.length === 0
            ? recovering.size > 0
            : current.every(({ connection }) => iceStalled(connection)),
        );
      }
      function iceStalled(connection: RTCPeerConnection) {
        return (
          connection.iceConnectionState === "disconnected" ||
          connection.iceConnectionState === "checking"
        );
      }
      function recover({ key, silenced, volume }: Link) {
        if (recovering.has(key) || !hasAudio || closed) return;
        const expiresAt = Date.now() + 18_000;
        const deadline = setTimeout(() => {
          stopRecovery(key);
          const replacement = [...links.values()].find(
            (item) => item.key === key,
          );
          if (replacement && !replacement.ready) {
            leave(replacement.id, false);
            replacement.connection.close();
          }
          signaling.remove(key);
          refreshIce();
          if (!members().length && !recovering.size) onDisconnect();
        }, expiresAt - Date.now());
        const retries: ReturnType<typeof setTimeout>[] = [];
        recovering.set(key, { expiresAt, deadline, retries, silenced, volume });
        callMetric("link_recovery_started");
        if (localKey < key) {
          void signaling
            .offer(key, { recovery: true, expiresAt })
            .catch(() => undefined);
          for (const delay of [1_500, 4_000, 8_000])
            retries.push(
              setTimeout(() => {
                void signaling.repeatOffer(key).catch(() => undefined);
              }, delay),
            );
        }
      }
      let soloId: string | undefined;
      function startConferenceVideo() {
        if (conferenceVideo || closed) return;
        stopSoloVideo();
        grouped = true;
        conferenceVideo = bindConferenceVideo({
          nativeStream: rtc.MediaStream,
          room,
          callId: invite.callId,
          signal,
          onVideo,
          openCamera: (operation, onEnded) =>
            captureCamera({
              rtc,
              operation,
              onEnded,
              onCameraPrompt,
              waitForForeground,
            }),
          randomCallId,
          localKey,
        });
        for (const link of members()) conferenceVideo.add(link);
      }
      function configureVideo(link: Link) {
        if (grouped || members().length > 1) {
          startConferenceVideo();
          conferenceVideo?.add(link);
        } else if (!video) {
          soloId = link.id;
          video = bindTrysteroVideo({
            rtc,
            room,
            connection: link.connection,
            callId: invite.callId,
            coordinator: invite.senderKey === localKey,
            peerId: link.id,
            signal,
            subscriptions: videoSubscriptions,
            turnSubscriptions: subscriptions,
            isDirect,
            randomCallId,
            waitForForeground,
            onCameraPrompt,
            onVideo,
            getPolicy: () => videoPolicy.get(link.key),
            allowAlways: () => videoPolicy.allow(link.key),
          });
        }
      }
      function promote(link: Link) {
        if (recovering.has(link.key)) {
          stopRecovery(link.key);
          callMetric("link_recovered");
        }
        link.ready = true;
        const { connection } = link;
        let restart: ReturnType<typeof setTimeout> | undefined;
        let stalled: ReturnType<typeof setTimeout> | undefined;
        let attempted = false;
        const changed = () => {
          refreshIce();
          const ice = connection.iceConnectionState;
          if (ice === "connected" || ice === "completed") attempted = false;
          if (iceStalled(connection)) {
            stalled ??= setTimeout(() => {
              stalled = undefined;
              if (!isMember(link.id) || !iceStalled(connection)) return;
              callMetric("ice_restart_stalled");
              leave(link.id, false);
              connection.close();
            }, 8_000);
          } else {
            clearTimeout(stalled);
            stalled = undefined;
          }
          if (ice !== "disconnected") {
            clearTimeout(restart);
            restart = undefined;
          } else if (!attempted && !restart) {
            restart = setTimeout(
              () => {
                restart = undefined;
                if (
                  !isMember(link.id) ||
                  connection.iceConnectionState !== "disconnected"
                )
                  return;
                attempted = true;
                callMetric("ice_restart_requested");
                try {
                  connection.restartIce();
                } catch {
                  callMetric("ice_restart_unavailable");
                }
              },
              localKey < link.key ? 700 : 2_500,
            );
          }
        };
        connection.addEventListener("iceconnectionstatechange", changed);
        link.iceListener = () => {
          clearTimeout(restart);
          clearTimeout(stalled);
          connection.removeEventListener("iceconnectionstatechange", changed);
        };
        changed();
        configureVideo(link);
        showParticipants();
        if (__DEV__) {
          console.info("[call] peer ready", {
            peers: members().length,
            ms: Math.round(performance.now() - link.started),
          });
        }
        void muteState
          .send(muted, { target: link.id, signal: link.abort.signal })
          .catch(() => undefined);
      }
      subscriptions.push(
        reserve.onRequest(async (data, { peerId }) => {
          const link = links.get(peerId);
          const request = reservationRequest.safeParse(data).data;
          return (
            !!link &&
            !!request &&
            isMember(peerId) &&
            (!authorizePeers ||
              (await authorizePeers([
                request.recipient,
                ...request.invitation.roster,
              ]))) &&
            isMember(peerId) &&
            reservations.reserve(request, link.key)
          );
        }),
        grant.onRequest(async (data, { peerId }) => {
          const link = links.get(peerId);
          const id = opaqueId.safeParse(data).data;
          const seat = reservations.current();
          return (
            !!link &&
            isMember(peerId) &&
            !!id &&
            seat?.request.invitation.id === id &&
            (!authorizePeers ||
              (await authorizePeers([
                seat.request.recipient,
                ...seat.request.invitation.roster,
              ]))) &&
            isMember(peerId) &&
            reservations.authorize(id, link.key)
          );
        }),
        admit.onRequest((data, { peerId }) => {
          const link = links.get(peerId);
          if (
            !link ||
            !isDirect(peerId) ||
            !link.mediaReady ||
            link.seatId !== data ||
            !opaqueId.safeParse(data).success
          )
            return false;
          if (link.ready) return true;
          const seat = reservations.current();
          if (
            seat?.request.invitation.id !== data ||
            !reservations.permits(link.key)
          )
            return false;
          reservations.consume(link.key);
          promote(link);
          return true;
        }),
        release.onMessage((id, { peerId }) => {
          const link = links.get(peerId);
          if (!link || !isMember(peerId) || !opaqueId.safeParse(id).success)
            return;
          revokeSeat(id, link.key);
        }),
        confirmMedia.onMessage((data, { peerId }) => {
          const link = links.get(peerId);
          if (data !== "ready" || !link || !isDirect(peerId)) return;
          link.confirmed = true;
          link.wake?.();
        }),
        hangup.onMessage((data, { peerId }) => {
          if (data !== "end" || !isDirect(peerId)) return;
          const connection = links.get(peerId)?.connection;
          leave(peerId, true);
          connection?.close();
        }),
        muteState.onMessage((value, { peerId }) => {
          const link = links.get(peerId);
          if (
            typeof value !== "boolean" ||
            !link ||
            !isDirect(peerId) ||
            link.muted === value
          )
            return;
          link.muted = value;
          if (link.key === peerKey) onRemoteMute(value);
          if (link.ready) showParticipants();
        }),
        room.onPeerLeave(({ peerId }) => leave(peerId, false)),
      );

      function waitFor(link: Link, test: () => boolean) {
        return pending<void>(link.abort.signal, (resolve) => {
          link.wake = () => {
            if (test()) {
              link.wake = undefined;
              resolve();
            }
          };
          link.wake();
        });
      }

      async function join(id: string) {
        const connection = room.getPeers()[id]?.connection;
        if (!connection || handshakes.has(id) || links.has(id)) return;
        const abort = new AbortController();
        const started = performance.now();
        callMetric("trystero_peer_ready", {
          ice: connection.iceConnectionState,
        });
        const operation = abort.signal;
        handshakes.set(id, abort);
        const conferenceSetup =
          joiningConference || reservations.current() !== undefined;
        const deadline = setTimeout(
          () => abort.abort(),
          conferenceSetup ? 30_000 : 20_000,
        );
        try {
          const challenge = randomCallId();
          const request = JSON.stringify({ key: localKey, challenge });
          let key: string | undefined;
          const proofDeadline = Date.now() + 8_000;
          while (!key) {
            operation.throwIfAborted();
            const raw = await exchange.request(request, {
              target: id,
              timeoutMs: 4_000,
              signal: operation,
            });
            if (typeof raw !== "string" || raw.length > 4096)
              throw new Error("Invalid peer proof");
            if (raw) {
              const proof: unknown = JSON.parse(raw);
              const claimed = proofKey.safeParse(proof).data?.pubkey;
              if (
                !claimed ||
                !verifyPeerProof(
                  proof,
                  transcript(
                    { id, key: claimed, connection },
                    challenge,
                    false,
                  ),
                  claimed,
                  Math.floor(Date.now() / 1000),
                )
              )
                throw new Error("Invalid peer proof");
              if (eligible(claimed) && signaling.matches(claimed, id))
                key = claimed;
            }
            if (!key) {
              if (Date.now() >= proofDeadline)
                throw new Error("Peer is not admitted");
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
          if (authorizePeers && !(await authorizePeers([key])))
            throw new Error("Peer authorization expired");
          if (
            closed ||
            isBlocked(key) ||
            room.getPeers()[id]?.connection !== connection ||
            links.size >= callCapacity - 1 ||
            [...links.values()].some((link) => link.key === key)
          )
            throw new Error("Peer connection changed");
          if (
            invite.conference &&
            key !== peerKey &&
            joiningConference &&
            ![...links.values()].some((link) => link.key === peerKey)
          ) {
            await firstProof;
            operation.throwIfAborted();
            if (![...links.values()].some((link) => link.key === peerKey))
              throw new Error("Inviting member left");
          }
          const transceiver = connection
            .getTransceivers()
            .find(
              ({ receiver, currentDirection }) =>
                receiver.track?.kind === "audio" &&
                currentDirection === "sendrecv",
            );
          if (!transceiver) throw new Error("No negotiated audio transceiver");
          const link: Link = {
            id,
            key,
            connection,
            abort,
            started,
            ready: false,
            mediaReady: false,
            seatId: reservations.permits(key)
              ? reservations.current()?.request.invitation.id
              : undefined,
            confirmed: false,
            audio: transceiver.receiver.track,
            muted: false,
            silenced: recovering.get(key)?.silenced ?? false,
            volume: recovering.get(key)?.volume ?? 100,
            speaking: false,
            speakingUntil: 0,
          };
          links.set(id, link);
          signaling.connected(key);
          if (key === peerKey) {
            onAuthenticated({ notifyHangup });
            activateAudio?.();
          }
          await audioReady;
          operation.throwIfAborted();
          if (!localStream || !isDirect(id) || !eligible(key))
            throw new Error("Peer session unavailable");
          const [track] = localStream.getAudioTracks();
          if (!track) throw new Error("No microphone");
          if (authorizePeers && !(await authorizePeers([key])))
            throw new Error("Peer authorization expired");
          operation.throwIfAborted();
          await transceiver.sender.replaceTrack(
            track as unknown as MediaStreamTrack,
          );
          operation.throwIfAborted();
          if (isBlocked(key)) throw new Error("Peer authorization expired");
          if (transceiver.sender.track?.id !== track.id)
            throw new Error("Native microphone attachment failed");
          callMetric("audio_track_attached");
          void traceAudioPackets(connection, operation);
          authorized.set(connection, link.audio);
          link.audio.enabled = !link.silenced;
          if (link.volume !== 100 && link.audio instanceof rtc.MediaStreamTrack)
            (link.audio as unknown as NativeTrack)._setVolume(
              link.volume / 100,
            );
          await Promise.all([
            confirmMedia.send("ready", { target: id, signal: operation }),
            waitFor(link, () => link.confirmed),
          ]);
          operation.throwIfAborted();
          if (!eligible(key)) throw new Error("Peer authorization expired");
          link.mediaReady = true;
          if (__DEV__ && (joiningConference || link.seatId)) {
            console.info("[call] conference link has audio", {
              ms: Math.round(performance.now() - started),
              links: [...links.values()].filter((link) => link.mediaReady)
                .length,
            });
          }
          if (!joiningConference && !link.seatId) promote(link);
          if (key === peerKey) firstAudio?.();
          if (
            joiningConference &&
            [...initial].every((key) =>
              [...links.values()].some(
                (member) => member.key === key && member.mediaReady,
              ),
            )
          )
            fullRoster?.();
        } catch (failure) {
          if (__DEV__)
            console.info("[call] peer setup stopped", {
              stage: links.has(id) ? "media" : "proof",
              timeout: operation.aborted,
              reason: failure instanceof Error ? failure.name : "unknown",
            });
          leave(id, false);
          connection.close();
        } finally {
          clearTimeout(deadline);
          handshakes.delete(id);
        }
      }

      subscriptions.push(
        room.onPeerJoin(({ peerId }) => void join(peerId), { replay: true }),
      );
      signaling.scopeFor((key, message) => {
        if (message.recovery) {
          let recovery = recovering.get(key);
          if (!recovery && "offer" in message.payload && key < localKey) {
            const old = members().find((item) => item.key === key);
            if (
              old &&
              (iceStalled(old.connection) ||
                old.connection.connectionState === "failed" ||
                old.connection.connectionState === "closed")
            ) {
              leave(old.id, false);
              old.connection.close();
              recovery = recovering.get(key);
            }
          }
          if (!recovery || ("offer" in message.payload && key >= localKey))
            return;
          return { recovery: true, expiresAt: recovery.expiresAt };
        }
        if (initial.has(key)) return initialScope;
        const seat = reservations.current();
        if (seat?.request.recipient !== key || !reservations.permits(key))
          return;
        return {
          invitationId: seat.request.invitation.id,
          expiresAt: seat.request.expiresAt,
        };
      });
      if (invite.recipientKey === localKey) {
        if (!invite.offer) throw new Error("No prepared RTC offer");
        void signaling
          .applyOffer(peerKey, initialScope, invite.offer)
          .catch(() => onDisconnect());
      } else {
        signaling.startCandidates(peerKey);
      }
      await Promise.all([
        firstProof,
        requestMicrophone(signal, onMicrophonePrompt),
      ]);
      if (invite.conference) {
        for (const key of initial)
          if (key !== peerKey && key !== localKey)
            void signaling.offer(key, initialScope).catch(() => undefined);
      }
      // The proof can finish before the relay acknowledges acceptance.
      if (!(await acceptance)) throw new Error("Acceptance was not published");
      signal.throwIfAborted();
      callMetric("native_audio_started");
      const telecom = await openSystemAudio({
        invite,
        peerKey,
        signal,
        onRouting,
      });
      signal.throwIfAborted();
      audio = telecom ?? openCallAudio(onRouting, onDisconnect);
      const backgroundAudio = telecom !== null || Platform.OS === "ios";
      callMetric("native_audio_ready", {
        telecom: telecom !== null,
        backgroundAudio,
      });
      let captured: NativeStream;
      try {
        callMetric("microphone_capture_started");
        captured = await rtc.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      } catch {
        throw new Error("microphone-permission");
      }
      if (signal.aborted) {
        for (const track of captured.getTracks()) track.stop();
        captured.release();
        signal.throwIfAborted();
      }
      localStream = captured;
      callMetric("microphone_capture_ready");
      const tracks = captured.getAudioTracks();
      if (!tracks.length) throw new Error("No microphone");
      for (const track of tracks) track.onended = onDisconnect;
      startMedia?.();
      await firstMedia;
      callMetric("media_ready");
      signal.throwIfAborted();
      if (invite.conference) {
        try {
          await rosterMedia;
          signal.throwIfAborted();
          const accepted = [...links.values()].filter(
            (link) => initial.has(link.key) && link.mediaReady,
          );
          if (accepted.length !== invite.conference.roster.length)
            throw new Error("Conference roster changed");
          const results = await admit.requestMany(invite.conference.id, {
            targets: accepted.map(({ id }) => id),
            timeoutMs: 3_500,
            signal,
          });
          if (
            results.length !== accepted.length ||
            !results.every(
              (result) => result.status === "fulfilled" && result.value,
            )
          )
            throw new Error(
              "Conference roster no longer admits this participant",
            );
          signal.throwIfAborted();
          if (!accepted.every(({ id }) => isDirect(id)))
            throw new Error("Conference connection changed");
          joiningConference = false;
          for (const link of accepted) promote(link);
        } catch (error) {
          await notifyHangup().catch(() => undefined);
          throw error;
        }
      }
      hasAudio = true;

      let sampling = false;
      const meter = setInterval(() => {
        const online = members();
        if (sampling || online.length < 2 || AppState.currentState !== "active")
          return;
        sampling = true;
        void Promise.all(
          online.map(async (link) => {
            const stats = await link.connection.getStats().catch(() => null);
            if (!isMember(link.id)) return false;
            for (const value of stats?.values() ?? []) {
              if (
                value.type === "inbound-rtp" &&
                value.kind === "audio" &&
                Number(value.audioLevel) >= (link.speaking ? 0.012 : 0.025) &&
                !link.muted &&
                !link.silenced
              )
                link.speakingUntil = Date.now() + 650;
            }
            const speaking =
              link.speakingUntil > Date.now() && !link.muted && !link.silenced;
            if (speaking === link.speaking) return false;
            link.speaking = speaking;
            return true;
          }),
        )
          .then((changes) => {
            if (changes.some(Boolean) && !closed) showParticipants();
          })
          .finally(() => {
            sampling = false;
          });
      }, 350);
      subscriptions.push(() => clearInterval(meter));

      function revokeSeat(id: string, issuer: string) {
        const seat = reservations.current();
        if (seat?.inviter !== issuer || seat.request.invitation.id !== id)
          return false;
        reservations.release(id, issuer);
        for (const link of links.values()) {
          if (link.ready || link.key !== seat.request.recipient) continue;
          leave(link.id, false);
          link.connection.close();
        }
        return true;
      }
      function revoke(id: string) {
        if (!revokeSeat(id, localKey)) return;
        void release
          .send(id, { target: members().map((link) => link.id), signal })
          .catch(() => undefined);
      }
      return {
        backgroundAudio,
        involves: (key) =>
          recovering.has(key) ||
          [...links.values()].some((link) => link.key === key),
        close,
        notifyHangup,
        get video() {
          return conferenceVideo ?? video;
        },
        conference: {
          revokePeer(key) {
            initial.delete(key);
            stopRecovery(key);
            const seat = reservations.current();
            if (
              seat &&
              (seat.request.recipient === key ||
                seat.request.invitation.roster.includes(key))
            )
              revoke(seat.request.invitation.id);
            signaling.remove(key);
            for (const link of links.values()) {
              if (link.key === key) {
                leave(link.id, true);
                link.connection.close();
              }
            }
          },
          async reserve(request) {
            if (!reservations.reserve(request, localKey)) return false;
            const targets = members().map((link) => link.id);
            const results = await reserve.requestMany(request, {
              targets,
              timeoutMs: 2_500,
              signal,
            });
            const ok =
              results.length === targets.length &&
              results.every(
                (result) =>
                  result.status === "fulfilled" && result.value === true,
              );
            if (!ok) revoke(request.invitation.id);
            return ok;
          },
          async authorize(id) {
            const seat = reservations.current();
            if (seat?.inviter !== localKey || seat.request.invitation.id !== id)
              return false;
            const targets = members()
              .filter((link) =>
                seat.request.invitation.roster.includes(link.key),
              )
              .map(({ id }) => id);
            if (targets.length + 1 !== seat.request.invitation.roster.length) {
              revoke(id);
              return false;
            }
            const results = await grant.requestMany(id, {
              targets,
              timeoutMs: 3_500,
              signal,
            });
            const ok =
              results.length === targets.length &&
              results.every(
                (result) =>
                  result.status === "fulfilled" && result.value === true,
              );
            if (!ok) {
              revoke(id);
              return false;
            }
            if (!reservations.authorize(id, localKey)) return false;
            signaling.startCandidates(seat.request.recipient);
            return true;
          },
          release(id) {
            const seat = reservations.current();
            if (seat?.request.invitation.id === id)
              signaling.remove(seat.request.recipient);
            revoke(id);
          },
          silence(key, value) {
            const link = members().find((item) => item.key === key);
            if (!link) return;
            link.silenced = value;
            link.audio.enabled = !value;
            showParticipants();
          },
          volume(key, value) {
            const link = members().find((item) => item.key === key);
            if (!link || !(link.audio instanceof rtc.MediaStreamTrack)) return;
            (link.audio as unknown as NativeTrack)._setVolume(value / 100);
            link.volume = value;
            showParticipants();
          },
        },
        async inspect() {
          const active = members();
          let sentPackets = 0;
          let receivedPackets = 0;
          for (const link of active) {
            for (const value of (await link.connection.getStats()).values()) {
              if (value.kind !== "audio") continue;
              if (value.type === "outbound-rtp")
                sentPackets += Number(value.packetsSent) || 0;
              if (value.type === "inbound-rtp")
                receivedPackets += Number(value.packetsReceived) || 0;
            }
          }
          return {
            ice: active[0]?.connection.iceConnectionState ?? "closed",
            microphone: tracks.some(
              (track) => track.enabled && track.readyState === "live",
            ),
            remoteTrack: active.some(
              (link) => link.audio.readyState === "live",
            ),
            sentPackets,
            receivedPackets,
          };
        },
        mute(value) {
          muted = value;
          for (const track of tracks) track.enabled = !muted;
          void muteState
            .send(muted, { target: members().map((link) => link.id), signal })
            .catch(() => undefined);
        },
        route: async (value) => audio?.route(value),
      };
    } catch (error) {
      close();
      throw error;
    }
  };
  return {
    open,
    async prepare(invite: InviteDraft, signal: AbortSignal) {
      const { signaling } = await session(invite, signal);
      return signaling.prepare(invite.recipientKey, {
        invitationId: invite.conference?.id,
        expiresAt: invite.expiresAt,
      });
    },
    receive(message: RtcSignal) {
      if (current?.id === message.callId)
        void current.ready
          .then(({ signaling }) => signaling.receive(message))
          .catch(() => undefined);
    },
  };
}
