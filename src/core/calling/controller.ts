import { z } from "zod";
import { createStore } from "zustand/vanilla";
import { publicKeySchema } from "../identity/keys";
import {
  type ConferenceMedia,
  callCapacity,
  type InvitationView,
  type Participant,
  type ParticipantVolume,
} from "./conference";
import { callMetric } from "./diagnostics";
import {
  type CallResponse,
  type CallSignal,
  type InviteDraft,
  inviteLifetime,
  type RtcOffer,
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
  participantKeys?: string[];
  invitationIds?: string[];
};
export type CallView = Pick<
  CallRecord,
  "id" | "peerKey" | "direction" | "startedAt"
> &
  (
    | {
        phase: "outgoing" | "ringing" | "incoming" | "connecting" | "ending";
        inviteCount?: number;
      }
    | {
        phase: "connected";
        answeredAt: number;
        muted: boolean;
        remoteMuted: boolean;
        routing: Routing;
        reconnecting: boolean;
        expandable?: boolean;
      }
    | { phase: "ended"; outcome: Outcome; reason?: CallFailure }
  );
type Attempt = {
  base: Pick<CallRecord, "id" | "peerKey" | "direction" | "startedAt">;
  invite: InviteDraft;
  abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  media?: CallMedia;
  notifyHangup?: CallMedia["notifyHangup"];
  answeredAt: number | null;
  stoppedAt?: number;
  microphonePrompt: boolean;
  cameraPrompt: boolean;
  direct: boolean;
  members: Set<string>;
  invitation?: { signal: InviteDraft; timer: ReturnType<typeof setTimeout> };
};

export type CallMedia = {
  backgroundAudio?: boolean;
  close(): void;
  mute(value: boolean): void;
  route(value: AudioRoute): Promise<void>;
  notifyHangup?(): Promise<void>;
  video?: VideoControls;
  conference?: ConferenceMedia;
  inspect?(): Promise<{
    ice: string;
    microphone: boolean;
    remoteTrack: boolean;
    sentPackets: number;
    receivedPackets: number;
  }>;
};
export type OpenMedia = (options: {
  invite: InviteDraft;
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
  onParticipants?: (participants: Participant[]) => void;
  onVideo: (video: VideoState | null) => void;
}) => Promise<CallMedia>;

export function createCallController({
  localKey,
  randomId,
  send,
  openMedia,
  prepareMedia,
  prepareInvite,
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
  prepareInvite: (
    invite: InviteDraft,
    signal: AbortSignal,
  ) => Promise<RtcOffer>;
  record: (entry: CallRecord) => void;
  hasRecord?: (callId: string, invitationId?: string) => boolean;
  tone: (mode: "incoming" | "ringing" | "silent") => void;
  now?: () => number;
  connectTimeout?: number;
}) {
  const store = createStore<{
    call: CallView | null;
    video: VideoState | null;
    participants: Participant[];
    invitations: InvitationView[];
  }>(() => ({ call: null, video: null, participants: [], invitations: [] }));
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
    invitationId?: string,
  ) {
    const createdAt = Math.floor(now() / 1_000) * 1_000;
    return publish(
      {
        version: 1,
        type,
        ...(invitationId ? { invitationId } : {}),
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

  function updateInvitation(
    invite: InviteDraft,
    phase: InvitationView["phase"],
  ) {
    if (!invite.conference) return;
    const entry = { key: invite.recipientKey, id: invite.conference.id, phase };
    store.setState(({ invitations }) => ({
      invitations: [
        ...invitations.filter(({ key }) => key !== entry.key),
        entry,
      ].slice(-callCapacity),
    }));
  }

  function settleInvitation(
    attempt: Attempt,
    phase: InvitationView["phase"],
    cancel = false,
  ) {
    const pending = attempt.invitation;
    if (!pending) return;
    const { signal: invite } = pending;
    clearTimeout(pending.timer);
    attempt.invitation = undefined;
    const id = invite.conference?.id;
    if (id) attempt.media?.conference?.release(id);
    updateInvitation(invite, phase);
    if (cancel)
      void response(
        "call.cancel",
        invite.recipientKey,
        invite.callId,
        undefined,
        id,
      );
  }

  function finish(attempt: Attempt, outcome: Outcome, reason?: CallFailure) {
    if (active !== attempt) return;
    settleInvitation(attempt, "cancelled", true);
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
      participants: [],
      invitations: [],
    });
    try {
      record({
        ...base,
        participantKeys: [...attempt.members],
        invitationIds: attempt.invite.conference
          ? [attempt.invite.conference.id]
          : [],
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

  function begin(invite: InviteDraft, direction: CallRecord["direction"]) {
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
      members: new Set([base.peerKey]),
    };
    active = attempt;
    store.setState({
      call: {
        ...base,
        phase: direction,
        inviteCount: invite.conference?.roster.length,
      },
      participants: [],
      invitations: [],
    });
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
    callMetric("private_setup_started", { answering });
    attempt.timer = setTimeout(() => {
      finish(attempt, "failed", "directFailed");
      if (!attempt.direct)
        void response(
          "call.end",
          base.peerKey,
          base.id,
          undefined,
          attempt.invite.conference?.id,
        );
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
            attempt.invite.conference?.id,
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
          callMetric("nostr_identity_verified");
          attempt.direct = true;
          attempt.notifyHangup = notifyHangup;
        },
        onParticipants: (participants) => {
          if (active !== attempt) return;
          for (const member of participants) attempt.members.add(member.key);
          if (
            participants.some(
              ({ key }) => key === attempt.invitation?.signal.recipientKey,
            )
          ) {
            clearTimeout(attempt.invitation?.timer);
            attempt.invitation = undefined;
          }
          store.setState(({ invitations }) => ({
            participants,
            invitations: invitations.filter(
              ({ key }) => !participants.some((member) => member.key === key),
            ),
          }));
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
      callMetric("call_connected");
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
          expandable: media.conference !== undefined,
        },
      });
    } catch (error) {
      if (active !== attempt) return;
      const reason =
        error instanceof Error && error.message === "microphone-permission"
          ? "microphonePermission"
          : "privateAudioFailed";
      finish(attempt, "failed", reason);
      if (!attempt.direct)
        void response(
          "call.end",
          base.peerKey,
          base.id,
          undefined,
          attempt.invite.conference?.id,
        );
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
    if (signal.type === "call.rtc") return;
    for (const [key, expires] of seen)
      if (expires <= receivedAt) seen.delete(key);
    const invitationKey = `${signal.senderKey}:${signal.callId}:${signal.type === "call.invite" ? (signal.conference?.id ?? "") : (signal.invitationId ?? "")}`;
    if (signal.type === "call.invite") {
      if (
        seen.has(invitationKey) ||
        seen.size >= 512 ||
        hasRecord?.(signal.callId, signal.conference?.id)
      )
        return;
      seen.set(invitationKey, signal.expiresAt);
      if (active) {
        const { call } = store.getState();
        const glare =
          !signal.conference &&
          !active.invite.conference &&
          active.base.peerKey === signal.senderKey &&
          (call?.phase === "outgoing" || call?.phase === "ringing");
        if (!glare || localKey < signal.senderKey) {
          void response(
            "call.busy",
            signal.senderKey,
            signal.callId,
            undefined,
            signal.conference?.id,
          );
          return;
        }
        const previous = active;
        finish(previous, "cancelled");
        void response("call.cancel", previous.base.peerKey, previous.base.id);
      }
      const incoming = begin(signal, "incoming");
      callMetric("recipient_ringing");
      tone("incoming");
      void response(
        "call.ringing",
        incoming.base.peerKey,
        incoming.base.id,
        () => available && active === incoming && !incoming.direct,
        incoming.invite.conference?.id,
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
    const pending = active?.invitation?.signal;
    if (
      active &&
      pending &&
      pending.callId === signal.callId &&
      pending.recipientKey === signal.senderKey &&
      signal.invitationId &&
      pending.conference?.id === signal.invitationId
    ) {
      const phase = store
        .getState()
        .invitations.find(({ id }) => id === signal.invitationId)?.phase;
      if (signal.type === "call.ringing" && phase === "inviting")
        updateInvitation(pending, "ringing");
      if (signal.type === "call.accept" && phase !== "connecting") {
        updateInvitation(pending, "connecting");
        const attempt = active;
        void active.media?.conference
          ?.authorize(signal.invitationId)
          .catch(() => false)
          .then((allowed) => {
            if (
              !allowed &&
              active === attempt &&
              attempt.invitation?.signal === pending
            )
              settleInvitation(attempt, "unavailable", true);
          });
      }
      if (signal.type === "call.reject") settleInvitation(active, "declined");
      if (signal.type === "call.busy") settleInvitation(active, "busy");
      if (signal.type === "call.end") settleInvitation(active, "unavailable");
      return;
    }
    if (
      !active ||
      active.invite.conference?.id !== signal.invitationId ||
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
        if (outgoing) {
          callMetric("answer_received");
          void connect(active, false);
        }
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
    async dial(peerKey: string) {
      if (
        active ||
        !publicKeySchema.safeParse(peerKey).success ||
        peerKey === localKey
      )
        return;
      const createdAt = Math.floor(now() / 1_000) * 1_000;
      const invite: InviteDraft = {
        version: 1,
        type: "call.invite",
        callId: randomId(),
        nonce: randomId(),
        senderKey: localKey,
        recipientKey: peerKey,
        createdAt,
        expiresAt: createdAt + inviteLifetime,
        roomId: randomId(),
      };
      callMetric("call_started");
      const attempt = begin(invite, "outgoing");
      const live = () => available && active === attempt;
      const offer = await prepareInvite(invite, attempt.abort.signal).catch(
        () => null,
      );
      if (!live()) return;
      if (offer) {
        const message = { ...invite, offer };
        attempt.invite = message;
        callMetric("invite_publish_started");
        const accepted = await publish(message, live);
        callMetric("invite_publish_finished", { accepted });
        if (accepted) return;
      }
      if (live() && store.getState().call?.phase === "outgoing")
        finish(attempt, "failed", "inviteFailed");
    },
    async invite(key: string) {
      const attempt = active;
      const media = attempt?.media?.conference;
      const { call, participants } = store.getState();
      if (
        !available ||
        !attempt ||
        !media ||
        call?.phase !== "connected" ||
        attempt.invitation ||
        key === localKey ||
        !publicKeySchema.safeParse(key).success ||
        participants.some((member) => member.key === key) ||
        participants.length + 1 >= callCapacity ||
        !participants.length
      )
        return false;
      const createdAt = Math.floor(now() / 1_000) * 1_000;
      const invite: InviteDraft = {
        ...attempt.invite,
        nonce: randomId(),
        senderKey: localKey,
        recipientKey: key,
        createdAt,
        expiresAt: createdAt + inviteLifetime,
        conference: {
          id: randomId(),
          capacity: callCapacity,
          roster: [localKey, ...participants.map((member) => member.key)],
        },
      };
      const pending = {
        signal: invite,
        timer: setTimeout(
          () => settleInvitation(attempt, "timed-out", true),
          invite.expiresAt - now(),
        ),
      };
      attempt.invitation = pending;
      updateInvitation(invite, "inviting");
      const live = () =>
        available && active === attempt && attempt.invitation === pending;
      const reserved =
        invite.conference &&
        (await media
          .reserve({
            version: 1,
            callId: invite.callId,
            invitation: invite.conference,
            recipient: key,
            expiresAt: invite.expiresAt,
          })
          .catch(() => false));
      if (!live()) return false;
      const offer = reserved
        ? await prepareInvite(invite, attempt.abort.signal).catch(() => null)
        : null;
      if (!live()) return false;
      if (!offer || !(await publish({ ...invite, offer }, live))) {
        if (live()) settleInvitation(attempt, "unavailable", true);
        return false;
      }
      return true;
    },
    cancelInvitation() {
      if (active) settleInvitation(active, "cancelled", true);
    },
    silence(key: string, muted: boolean) {
      active?.media?.conference?.silence(key, muted);
    },
    volume(key: string, volume: ParticipantVolume) {
      active?.media?.conference?.volume(key, volume);
    },
    accept() {
      if (active && store.getState().call?.phase === "incoming") {
        callMetric("answer_pressed");
        void connect(active, true);
      }
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
      void response(
        type,
        attempt.base.peerKey,
        attempt.base.id,
        undefined,
        attempt.invite.conference?.id,
      );
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
