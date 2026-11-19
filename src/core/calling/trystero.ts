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
import { admission, callCapacity, type ParticipantVolume } from "./conference";
import { bindConferenceVideo } from "./conference-video";
import type { OpenMedia } from "./controller";
import { openCallAudio } from "./native-audio";
import { askForMicrophone, hasMicrophonePermission } from "./permissions";
import {
  opaqueId,
  peerTranscript,
  proofKind,
  verifyPeerProof,
} from "./protocol";
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
  const { joinRoom }: typeof import("trystero") = require("trystero");
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
): OpenMedia {
  const localKey = signer.userSync.pubkey;
  return async ({
    invite,
    peerKey,
    signal,
    acceptance,
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
    const rtc = await initializeCallingRuntime();
    signal.throwIfAborted();
    const expandable = invite.expandable === 2;
    const room = rtc.joinRoom(
      {
        appId: "app.boop.mobile.voice.v1",
        password: invite.roomSecret,
        identity: "none",
        maxUsers: expandable ? callCapacity : 2,
        relayConfig: { warnOnRelayFailure: false },
      },
      invite.roomId,
    );
    type Link = {
      id: string;
      key: string;
      connection: RTCPeerConnection;
      abort: AbortController;
      audio?: MediaStream;
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
    const earlyAudio = new Map<string, MediaStream>();
    const initial = new Set(invite.conference?.roster ?? [peerKey]);
    const members = () => [...links.values()].filter((link) => link.ready);
    const reservations = admission({
      localKey,
      callId: invite.callId,
      connected: () => members().map(({ key }) => key),
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
      for (const link of links.values()) link.abort.abort();
      for (const unsubscribe of subscriptions) unsubscribe();
      for (const track of localStream?.getTracks() ?? []) track.stop();
      localStream?.release();
      audio?.close();
      void room.leave().catch(() => undefined);
    }
    signal.addEventListener("abort", close, { once: true });
    try {
      const { peerId: selfId } = await room.getSelf();
      signal.throwIfAborted();
      const exchange = room.makeAction<string, string>(
        expandable ? "boop-proof2" : "boop-proof",
        { kind: "request" },
      );
      const hangup = room.makeAction<string>("boop-end");
      const muteState = room.makeAction<boolean>("boop-mute");
      const confirmMedia = room.makeAction<string>("boop-media");
      const reserve = room.makeAction("boop-seat", { kind: "request" });
      const grant = room.makeAction("boop-grant", { kind: "request" });
      const admit = room.makeAction<string, boolean>("boop-admit", {
        kind: "request",
      });
      const release = room.makeAction<string>("boop-unseat");
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
        initial.has(key) || reservations.permits(key);

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
          const request = expandable
            ? proofRequest.safeParse(JSON.parse(data)).data
            : { challenge: opaqueId.parse(data), key: peerKey };
          if (!request || !eligible(request.key)) return "";
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
        earlyAudio.delete(id);
        const link = links.get(id);
        if (!link) return;
        links.delete(id);
        link.abort.abort();
        link.iceListener?.();
        link.audio?.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
        conferenceVideo?.remove(id);
        if (id === soloId) stopSoloVideo();
        if (!link.ready) {
          if (joiningConference && initial.has(link.key)) onDisconnect();
          return;
        }
        initial.delete(link.key);
        showParticipants();
        refreshIce();
        if (!hasAudio || members().length) return;
        if (graceful) onHangup();
        else onDisconnect();
      }
      function refreshIce() {
        const current = members();
        onReconnecting(
          current.length > 0 &&
            current.every(
              (link) => link.connection.iceConnectionState === "disconnected",
            ),
        );
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
        link.ready = true;
        const { connection } = link;
        connection.addEventListener("iceconnectionstatechange", refreshIce);
        link.iceListener = () =>
          connection.removeEventListener(
            "iceconnectionstatechange",
            refreshIce,
          );
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
        reserve.onRequest((data, { peerId }) => {
          const link = links.get(peerId);
          return (
            !!link && isMember(peerId) && reservations.reserve(data, link.key)
          );
        }),
        grant.onRequest((data, { peerId }) => {
          const link = links.get(peerId);
          const id = opaqueId.safeParse(data).data;
          return (
            !!link &&
            isMember(peerId) &&
            !!id &&
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
        room.onPeerStream((stream, { peerId }) => {
          const tracks = stream.getAudioTracks();
          if (!tracks.some((track) => track.readyState === "live")) return;
          const link = links.get(peerId);
          const authorized = isDirect(peerId);
          for (const track of tracks)
            track.enabled = authorized && !link?.silenced;
          if (link && authorized) {
            link.audio = stream;
            link.wake?.();
          } else if (handshakes.has(peerId)) earlyAudio.set(peerId, stream);
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
          const request = expandable
            ? JSON.stringify({ key: localKey, challenge })
            : challenge;
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
              if (eligible(claimed)) key = claimed;
            }
            if (!key) {
              if (Date.now() >= proofDeadline)
                throw new Error("Peer is not admitted");
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
          if (
            closed ||
            room.getPeers()[id]?.connection !== connection ||
            links.size >= (expandable ? callCapacity - 1 : 1) ||
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
            audio: earlyAudio.get(id),
            muted: false,
            silenced: false,
            volume: 100,
            speaking: false,
            speakingUntil: 0,
          };
          links.set(id, link);
          earlyAudio.delete(id);
          if (key === peerKey) {
            onAuthenticated({ notifyHangup });
            activateAudio?.();
          }
          await audioReady;
          operation.throwIfAborted();
          if (!localStream || !isDirect(id) || !eligible(key))
            throw new Error("Peer session unavailable");
          link.audio?.getAudioTracks().forEach((track) => {
            track.enabled = true;
          });
          const remote = () =>
            waitFor(
              link,
              () =>
                link.audio
                  ?.getAudioTracks()
                  .some((track) => track.readyState === "live") === true,
            );
          const attach = () => {
            operation.throwIfAborted();
            if (!eligible(key)) throw new Error("Peer authorization expired");
            return room.addStream(localStream as unknown as MediaStream, {
              target: id,
            });
          };
          const first =
            !invite.conference && links.size === 1 && initial.has(key)
              ? invite.senderKey === localKey
              : localKey < key;
          if (first) await Promise.all([remote(), attach()]);
          else {
            await remote();
            await stableSignaling(connection, operation);
            await attach();
          }
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
      await firstProof;
      // The proof can finish before the relay acknowledges acceptance.
      if (!(await acceptance)) throw new Error("Acceptance was not published");
      signal.throwIfAborted();
      await requestMicrophone(signal, onMicrophonePrompt);
      const telecom = await openSystemAudio({
        invite,
        peerKey,
        signal,
        onRouting,
      });
      signal.throwIfAborted();
      audio = telecom ?? openCallAudio(onRouting, onDisconnect);
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
        captured.release();
        signal.throwIfAborted();
      }
      localStream = captured;
      const tracks = captured.getAudioTracks();
      if (!tracks.length) throw new Error("No microphone");
      for (const track of tracks) track.onended = onDisconnect;
      startMedia?.();
      await firstMedia;
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
        backgroundAudio: telecom !== null || Platform.OS === "ios",
        close,
        notifyHangup,
        get video() {
          return conferenceVideo ?? video;
        },
        conference: expandable
          ? {
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
                if (
                  seat?.inviter !== localKey ||
                  seat.request.invitation.id !== id
                )
                  return false;
                const targets = members()
                  .filter((link) =>
                    seat.request.invitation.roster.includes(link.key),
                  )
                  .map(({ id }) => id);
                if (
                  targets.length + 1 !==
                  seat.request.invitation.roster.length
                ) {
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
                return reservations.authorize(id, localKey);
              },
              release: revoke,
              silence(key, value) {
                const link = members().find((item) => item.key === key);
                if (!link) return;
                link.silenced = value;
                for (const track of link.audio?.getAudioTracks() ?? [])
                  track.enabled = !value;
                showParticipants();
              },
              volume(key, value) {
                const link = members().find((item) => item.key === key);
                const tracks = link?.audio?.getAudioTracks();
                if (
                  !link ||
                  !tracks?.length ||
                  !tracks.every(
                    (track) => track instanceof rtc.MediaStreamTrack,
                  )
                )
                  return;
                for (const track of tracks)
                  (track as unknown as NativeTrack)._setVolume(value / 100);
                link.volume = value;
                showParticipants();
              },
            }
          : undefined,
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
            remoteTrack: active.some((link) =>
              link.audio
                ?.getAudioTracks()
                .some((track) => track.readyState === "live"),
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
}
