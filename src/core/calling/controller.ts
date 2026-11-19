import { z } from "zod";
import { createStore } from "zustand/vanilla";
import { publicKeySchema } from "../identity/keys";
import {
  type CallResponse,
  type CallSignal,
  type InviteSignal,
  inviteLifetime,
} from "./signals";
import type { VideoControls, VideoState } from "./video";

type CallFailure =
  | "directFailed"
  | "answerFailed"
  | "microphonePermission"
  | "privateAudioFailed"
  | "systemInterrupted"
  | "inviteFailed";

export type Outcome =
  | "completed"
  | "rejected"
  | "cancelled"
  | "missed"
  | "busy"
  | "unanswered"
  | "failed"
  | "remote-disconnected";
export const audioRoute = z.enum([
  "EARPIECE",
  "SPEAKER_PHONE",
  "BLUETOOTH",
  "WIRED_HEADSET",
]);
export type AudioRoute = z.infer<typeof audioRoute>;
export type Routing = { available: AudioRoute[]; selected: AudioRoute | null };
export type CallRecord = {
  id: string;
  peerKey: string;
  direction: "incoming" | "outgoing";
  startedAt: number;
  answeredAt: number | null;
  endedAt: number;
  durationSeconds: number;
  outcome: Outcome;
};
export type CallView = Pick<
  CallRecord,
  "id" | "peerKey" | "direction" | "startedAt"
> &
  (
    | { phase: "outgoing" | "ringing" | "incoming" | "connecting" | "ending" }
    | {
        phase: "connected";
        answeredAt: number;
        muted: boolean;
        remoteMuted: boolean;
        routing: Routing;
        reconnecting: boolean;
      }
    | { phase: "ended"; outcome: Outcome; reason?: CallFailure }
  );
type Attempt = {
  base: Pick<CallRecord, "id" | "peerKey" | "direction" | "startedAt">;
  invite: InviteSignal;
  abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  media?: CallMedia;
  notifyHangup?: CallMedia["notifyHangup"];
  answeredAt: number | null;
  stoppedAt?: number;
  microphonePrompt: boolean;
  cameraPrompt: boolean;
  direct: boolean;
};

export type CallMedia = {
  backgroundAudio?: boolean;
  close(): void;
  mute(value: boolean): void;
  route(value: AudioRoute): Promise<void>;
  notifyHangup?(): Promise<void>;
  video?: VideoControls;
  inspect?(): Promise<{
    ice: string;
    microphone: boolean;
    remoteTrack: boolean;
    sentPackets: number;
    receivedPackets: number;
  }>;
};
export type OpenMedia = (options: {
  invite: InviteSignal;
  peerKey: string;
  signal: AbortSignal;
  acceptance: Promise<boolean>;
  onDisconnect: () => void;
  onHangup: () => void;
  onRemoteMute: (muted: boolean) => void;
  onReconnecting: (reconnecting: boolean) => void;
  onRouting: (routing: Routing) => void;
  onMicrophonePrompt: (open: boolean) => void;
  onCameraPrompt: (open: boolean) => void;
  onAuthenticated: (media: Pick<CallMedia, "notifyHangup">) => void;
  onVideo: (video: VideoState | null) => void;
}) => Promise<CallMedia>;

export function createCallController({
  localKey,
  randomId,
  send,
  openMedia,
  prepareMedia,
  record,
  hasRecord,
  tone,
  now = Date.now,
  connectTimeout = 28_000,
}: {
  localKey: string;
  randomId: () => string;
  send: (signal: CallSignal, active: () => boolean) => Promise<boolean>;
  openMedia: OpenMedia;
  prepareMedia?: () => Promise<unknown>;
  record: (entry: CallRecord) => void;
  hasRecord?: (callId: string) => boolean;
  tone: (mode: "incoming" | "ringing" | "silent") => void;
  now?: () => number;
  connectTimeout?: number;
}) {
  const store = createStore<{
    call: CallView | null;
    video: VideoState | null;
  }>(() => ({ call: null, video: null }));
  const seen = new Map<string, number>();
  let active: Attempt | undefined;
  let available = false;

  const publish = (signal: CallSignal, live = () => available) =>
    send(signal, live).catch(() => false);

  function response(
    type: CallResponse,
    peerKey: string,
    callId: string,
    live?: () => boolean,
  ) {
    const createdAt = Math.floor(now() / 1_000) * 1_000;
    return publish(
      {
        version: 1,
        type,
        callId,
        nonce: randomId(),
        senderKey: localKey,
        recipientKey: peerKey,
        createdAt,
        expiresAt: createdAt + inviteLifetime,
      },
      live,
    );
  }

  function finish(attempt: Attempt, outcome: Outcome, reason?: CallFailure) {
    if (active !== attempt) return;
    active = undefined;
    clearTimeout(attempt.timer);
    attempt.abort.abort();
    attempt.media?.close();
    tone("silent");
    const endedAt = attempt.stoppedAt ?? now();
    const { answeredAt, base } = attempt;
    store.setState({
      call: { ...base, phase: "ended", outcome, reason },
      video: null,
    });
    try {
      record({
        ...base,
        outcome,
        answeredAt,
        endedAt,
        durationSeconds:
          answeredAt === null
            ? 0
            : Math.max(0, Math.floor((endedAt - answeredAt) / 1_000)),
      });
    } catch {
      // Device storage can fail independently of releasing call resources.
    }
  }

  function begin(invite: InviteSignal, direction: CallRecord["direction"]) {
    const base = {
      id: invite.callId,
      peerKey:
        direction === "incoming" ? invite.senderKey : invite.recipientKey,
      direction,
      startedAt: now(),
    };
    const attempt: Attempt = {
      base,
      invite,
      abort: new AbortController(),
      answeredAt: null,
      microphonePrompt: false,
      cameraPrompt: false,
      direct: false,
    };
    active = attempt;
    store.setState({ call: { ...base, phase: direction } });
    attempt.timer = setTimeout(
      () => {
        finish(attempt, direction === "incoming" ? "missed" : "unanswered");
      },
      Math.max(0, invite.expiresAt - now()),
    );
    void prepareMedia?.().catch(() => undefined);
    return attempt;
  }

  async function connect(attempt: Attempt, answering: boolean) {
    if (active !== attempt || now() >= attempt.invite.expiresAt) return;
    const { signal } = attempt.abort;
    const { base } = attempt;
    clearTimeout(attempt.timer);
    tone("silent");
    store.setState({ call: { ...base, phase: "connecting" } });
    attempt.timer = setTimeout(() => {
      finish(attempt, "failed", "directFailed");
      if (!attempt.direct) void response("call.end", base.peerKey, base.id);
    }, connectTimeout);
    let routing: Routing = { selected: null, available: [] };
    let remoteMuted = false;
    try {
      const acceptance = answering
        ? response(
            "call.accept",
            base.peerKey,
            base.id,
            () => available && active === attempt,
          )
        : Promise.resolve(true);
      void acceptance.then((accepted) => {
        if (!accepted) finish(attempt, "failed", "answerFailed");
      });
      const media = await openMedia({
        invite: attempt.invite,
        peerKey: base.peerKey,
        signal,
        acceptance,
        onDisconnect: () => {
          if (active !== attempt) return;
          const { call } = store.getState();
          if (call?.phase !== "connected") {
            if (call?.phase !== "ending")
              finish(attempt, "remote-disconnected");
            return;
          }
          attempt.media?.close();
          attempt.stoppedAt ??= now();
          store.setState({ call: { ...call, reconnecting: true } });
          clearTimeout(attempt.timer);
          attempt.timer = setTimeout(
            () => finish(attempt, "remote-disconnected"),
            1200,
          );
        },
        onHangup: () =>
          finish(
            attempt,
            attempt.answeredAt === null ? "remote-disconnected" : "completed",
          ),
        onRemoteMute: (muted) => {
          if (active !== attempt) return;
          remoteMuted = muted;
          const { call } = store.getState();
          if (call?.phase === "connected")
            store.setState({ call: { ...call, remoteMuted } });
        },
        onReconnecting: (reconnecting) => {
          const { call } = store.getState();
          if (active === attempt && call?.phase === "connected")
            store.setState({ call: { ...call, reconnecting } });
        },
        onMicrophonePrompt: (open) => {
          attempt.microphonePrompt = open;
        },
        onCameraPrompt: (open) => {
          attempt.cameraPrompt = open;
        },
        onAuthenticated: ({ notifyHangup }) => {
          if (active !== attempt) return;
          attempt.direct = true;
          attempt.notifyHangup = notifyHangup;
        },
        onVideo: (video) => {
          if (active === attempt) store.setState({ video });
        },
        onRouting: (next) => {
          routing = next;
          const { call } = store.getState();
          if (active === attempt && call?.phase === "connected") {
            store.setState({ call: { ...call, routing } });
          }
        },
      });
      if (signal.aborted) {
        media.close();
        return;
      }
      attempt.media = media;
      attempt.direct = true;
      attempt.notifyHangup = media.notifyHangup;
      if (!(await acceptance) || signal.aborted) return;
      attempt.answeredAt = now();
      clearTimeout(attempt.timer);
      store.setState({
        call: {
          ...base,
          phase: "connected",
          answeredAt: attempt.answeredAt,
          muted: false,
          remoteMuted,
          routing,
          reconnecting: false,
        },
      });
    } catch (error) {
      if (active !== attempt) return;
      const reason =
        error instanceof Error && error.message === "microphone-permission"
          ? "microphonePermission"
          : "privateAudioFailed";
      finish(attempt, "failed", reason);
      if (!attempt.direct) void response("call.end", base.peerKey, base.id);
    }
  }

  function receive(signal: CallSignal) {
    const receivedAt = now();
    if (signal.expiresAt <= receivedAt || signal.recipientKey !== localKey)
      return;
    if (
      !available &&
      (signal.type === "call.invite" || !active?.microphonePrompt)
    )
      return;
    for (const [key, expires] of seen)
      if (expires <= receivedAt) seen.delete(key);
    const invitationKey = `${signal.senderKey}:${signal.callId}`;
    if (signal.type === "call.invite") {
      if (
        seen.has(invitationKey) ||
        seen.size >= 512 ||
        hasRecord?.(signal.callId)
      )
        return;
      seen.set(invitationKey, signal.expiresAt);
      if (active) {
        const { call } = store.getState();
        const glare =
          active.base.peerKey === signal.senderKey &&
          (call?.phase === "outgoing" || call?.phase === "ringing");
        if (!glare || localKey < signal.senderKey) {
          void response("call.busy", signal.senderKey, signal.callId);
          return;
        }
        const previous = active;
        finish(previous, "cancelled");
        void response("call.cancel", previous.base.peerKey, previous.base.id);
      }
      const incoming = begin(signal, "incoming");
      tone("incoming");
      void response(
        "call.ringing",
        incoming.base.peerKey,
        incoming.base.id,
        () => available && active === incoming && !incoming.direct,
      );
      return;
    }
    if (
      (signal.type === "call.cancel" || signal.type === "call.end") &&
      (seen.has(invitationKey) || seen.size < 512)
    ) {
      seen.set(
        invitationKey,
        Math.max(seen.get(invitationKey) ?? 0, receivedAt + inviteLifetime),
      );
    }
    if (
      !active ||
      active.base.id !== signal.callId ||
      active.base.peerKey !== signal.senderKey ||
      active.direct
    )
      return;
    const { call } = store.getState();
    const outgoing = call?.phase === "outgoing" || call?.phase === "ringing";
    switch (signal.type) {
      case "call.ringing":
        if (call?.phase === "outgoing") {
          store.setState({ call: { ...active.base, phase: "ringing" } });
          tone("ringing");
        }
        break;
      case "call.accept":
        if (outgoing) void connect(active, false);
        break;
      case "call.reject":
        if (outgoing) finish(active, "rejected");
        break;
      case "call.busy":
        if (outgoing) finish(active, "busy");
        break;
      case "call.cancel":
        if (active.base.direction === "incoming" && call?.phase !== "connected")
          finish(active, "cancelled");
        break;
      case "call.end":
        finish(
          active,
          active.answeredAt !== null ? "completed" : "remote-disconnected",
        );
        break;
    }
  }

  return {
    store,
    receive,
    isRequestingMicrophone: () => active?.microphonePrompt === true,
    inspect: () => active?.media?.inspect?.(),
    setForeground(value: boolean) {
      available = value;
      if (
        !value &&
        active?.media?.backgroundAudio &&
        active.answeredAt !== null
      ) {
        if (!active.cameraPrompt) active.media.video?.suspendCamera();
        return;
      }
      if (
        !value &&
        active &&
        !active.microphonePrompt &&
        !active.cameraPrompt
      ) {
        const attempt = active;
        void attempt.notifyHangup?.().catch(() => undefined);
        finish(
          attempt,
          attempt.answeredAt === null ? "cancelled" : "remote-disconnected",
        );
      }
    },
    systemInterrupted(id: string) {
      if (active?.base.id !== id) return;
      const attempt = active;
      void attempt.notifyHangup?.().catch(() => undefined);
      finish(attempt, "failed", "systemInterrupted");
    },
    dial(peerKey: string) {
      if (
        active ||
        !publicKeySchema.safeParse(peerKey).success ||
        peerKey === localKey
      )
        return;
      const createdAt = Math.floor(now() / 1_000) * 1_000;
      const invite: InviteSignal = {
        version: 1,
        type: "call.invite",
        callId: randomId(),
        nonce: randomId(),
        senderKey: localKey,
        recipientKey: peerKey,
        createdAt,
        expiresAt: createdAt + inviteLifetime,
        roomId: randomId(),
        roomSecret: randomId(),
      };
      const attempt = begin(invite, "outgoing");
      void publish(invite, () => available && active === attempt).then(
        (accepted) => {
          if (!accepted && store.getState().call?.phase === "outgoing") {
            finish(attempt, "failed", "inviteFailed");
          }
        },
      );
    },
    accept() {
      if (active && store.getState().call?.phase === "incoming")
        void connect(active, true);
    },
    end() {
      if (!active) return;
      const attempt = active;
      const { call } = store.getState();
      if (call?.phase === "ending") return;
      if (attempt.direct) {
        clearTimeout(attempt.timer);
        attempt.media?.mute(true);
        attempt.media?.video?.close();
        attempt.stoppedAt = now();
        store.setState({ call: { ...attempt.base, phase: "ending" } });
        const done = () =>
          finish(
            attempt,
            attempt.answeredAt === null ? "cancelled" : "completed",
          );
        attempt.timer = setTimeout(done, 600);
        if (attempt.notifyHangup) void attempt.notifyHangup().then(done, done);
        else done();
        return;
      }
      const type =
        call?.phase === "incoming"
          ? "call.reject"
          : call?.phase === "outgoing" || call?.phase === "ringing"
            ? "call.cancel"
            : "call.end";
      finish(
        attempt,
        type === "call.reject"
          ? "rejected"
          : attempt.answeredAt === null
            ? "cancelled"
            : "completed",
      );
      void response(type, attempt.base.peerKey, attempt.base.id);
    },
    mute() {
      const { call } = store.getState();
      if (!active?.media || call?.phase !== "connected") return;
      active.media.mute(!call.muted);
      store.setState({ call: { ...call, muted: !call.muted } });
    },
    video: () =>
      store.getState().call?.phase === "connected"
        ? active?.media?.video
        : undefined,
    async route(route: AudioRoute) {
      const { call } = store.getState();
      if (
        call?.phase === "connected" &&
        call.routing.available.includes(route)
      ) {
        await active?.media?.route(route);
      }
    },
    dismiss(id: string) {
      const { call } = store.getState();
      if (call?.phase === "ended" && call.id === id)
        store.setState({ call: null });
    },
  };
}
