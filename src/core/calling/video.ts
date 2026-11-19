import { z } from "zod";
import { opaqueId } from "./protocol";

export type CameraFacing = "front" | "back";
export type VideoSource = "local" | "remote";
export type VideoDecision = "deny" | "allow-once" | "allow-always";
export type VideoError =
  | "permission"
  | "capture"
  | "denied"
  | "timeout"
  | "transmission"
  | "switch"
  | "background"
  | "preference";
type Feed = { url: string; facing: CameraFacing };
type LocalVideo =
  | { phase: "off" | "starting" }
  | ({ phase: "waiting" | "sending" | "sharing" | "preview" } & Feed);
type RemoteVideo =
  | { phase: "off" }
  | { phase: "requesting"; sequence: number; savedContact: boolean }
  | { phase: "authorized"; sequence: number }
  | { phase: "receiving"; sequence: number; url: string };

export type VideoState = {
  local: LocalVideo;
  remote: RemoteVideo;
  stage: VideoSource;
  corner: { right: boolean; bottom: boolean };
  error: VideoError | null;
  conference?: {
    cameras: Record<string, { watching: boolean; url?: string }>;
    focus: string | null;
    mode: "focus" | "grid";
  };
};

export function videoLayout({ local, remote, stage }: VideoState) {
  const localUrl = "url" in local ? local.url : null;
  const remoteUrl = remote.phase === "receiving" ? remote.url : null;
  const source = localUrl && remoteUrl ? stage : remoteUrl ? "remote" : "local";
  return {
    source,
    stageUrl: source === "remote" ? remoteUrl : localUrl,
    previewUrl: source === "remote" ? localUrl : remoteUrl,
    mirrorLocal: "facing" in local && local.facing === "front",
  };
}

const header = {
  version: z.literal(1),
  callId: opaqueId,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
export const videoOffer = z.strictObject({
  ...header,
  type: z.literal("offer"),
});
export const videoStop = z.strictObject({ ...header, type: z.literal("stop") });
export const cameraMetadata = z.strictObject({
  ...header,
  kind: z.literal("camera"),
});
export const videoReply = z.strictObject({ ...header, allowed: z.boolean() });
type Offer = z.infer<typeof videoOffer>;
type Stop = z.infer<typeof videoStop>;
type Metadata = z.infer<typeof cameraMetadata>;
export const consentTimeout = 30_000;

type Capture = {
  url: string;
  attach(metadata: Metadata): Promise<void>;
  stop(): void;
  switchTo(facing: CameraFacing): Promise<void>;
};

export type VideoControls = Pick<
  ReturnType<typeof createVideoSession>,
  | "enable"
  | "disable"
  | "suspendCamera"
  | "switchCamera"
  | "respond"
  | "swap"
  | "setCorner"
  | "close"
> & {
  watch?(key: string, watching: boolean): Promise<void>;
  focus?(key: string | null): void;
  mode?(mode: "focus" | "grid"): void;
};

export function createVideoSession({
  callId,
  capture,
  offer,
  stop,
  policy,
  allowAlways,
  foreground = () => true,
  update,
  timeout = consentTimeout,
}: {
  callId: string;
  capture: (signal: AbortSignal, onEnded: () => void) => Promise<Capture>;
  offer: (offer: Offer, signal: AbortSignal) => Promise<unknown>;
  stop: (message: Stop) => void;
  policy: () => "unknown" | "ask" | "always";
  allowAlways: () => boolean;
  foreground?: () => boolean;
  update: (state: VideoState | null) => void;
  timeout?: number;
}) {
  let state: VideoState = {
    local: { phase: "off" },
    remote: { phase: "off" },
    stage: "remote",
    corner: { right: true, bottom: false },
    error: null,
  };
  let sequence = 0;
  let remoteSequence = 0;
  let closed = false;
  let allowOnce = false;
  let captureQueue = Promise.resolve();
  let local:
    | {
        sequence: number;
        abort: AbortController;
        capture?: Capture;
        offered: boolean;
        frameDeadline?: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let switchInFlight = false;
  let pending:
    | { timer: ReturnType<typeof setTimeout>; settle: (allow: boolean) => void }
    | undefined;

  const show = (changes: Partial<VideoState>) => {
    if (closed) return;
    state = { ...state, ...changes };
    update(state);
  };
  const fields = (sequence: number) => ({
    version: 1 as const,
    callId,
    sequence,
  });

  function resetRemote() {
    pending?.settle(false);
    show({ remote: { phase: "off" }, stage: "remote" });
  }

  function disable(error: VideoError | null = null) {
    const previous = local;
    local = undefined;
    clearTimeout(previous?.frameDeadline);
    previous?.abort.abort();
    previous?.capture?.stop();
    if (previous?.offered) stop({ ...fields(previous.sequence), type: "stop" });
    show({ local: { phase: "off" }, error, stage: "remote" });
  }

  async function enable() {
    if (closed || local) return;
    const attempt = {
      sequence: ++sequence,
      abort: new AbortController(),
      offered: false,
    };
    local = attempt;
    show({ local: { phase: "starting" }, error: null });
    let failure: VideoError = "capture";
    try {
      const work = captureQueue.then(async () => {
        attempt.abort.signal.throwIfAborted();
        const device = await capture(attempt.abort.signal, () => {
          if (local === attempt) disable("capture");
        });
        if (local !== attempt) {
          device.stop();
          return null;
        }
        return device;
      });
      captureQueue = work.then(
        () => undefined,
        () => undefined,
      );
      const acquired = await work;
      if (!acquired) return;
      if (local !== attempt) {
        acquired.stop();
        return;
      }
      local.capture = acquired;
      const feed = { url: acquired.url, facing: "front" as const };
      show({ local: { phase: "waiting", ...feed } });
      attempt.offered = true;
      failure = "timeout";
      const reply = videoReply.safeParse(
        await offer(
          { ...fields(attempt.sequence), type: "offer" },
          attempt.abort.signal,
        ),
      );
      if (local !== attempt) return;
      if (
        !reply.success ||
        reply.data.callId !== callId ||
        reply.data.sequence !== attempt.sequence
      )
        return disable("transmission");
      if (!reply.data.allowed) return disable("denied");
      failure = "transmission";
      if (state.local.phase === "waiting")
        show({ local: { ...state.local, phase: "sending" } });
      await acquired.attach({ ...fields(attempt.sequence), kind: "camera" });
      if (local === attempt && state.local.phase === "sending")
        local.frameDeadline = setTimeout(() => {
          if (local === attempt && state.local.phase === "sending")
            disable("transmission");
        }, 8_000);
    } catch (error) {
      if (local === attempt)
        disable(
          error instanceof Error && error.message === "camera-permission"
            ? "permission"
            : failure,
        );
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    disable();
    resetRemote();
    update(null);
  }

  function receiveOffer(payload: unknown, request?: AbortSignal) {
    const { data } = videoOffer.safeParse(payload);
    if (!data || data.callId !== callId) return null;
    if (closed || request?.aborted || data.sequence <= remoteSequence)
      return { ...fields(data.sequence), allowed: false };
    remoteSequence = data.sequence;
    resetRemote();
    const preference = policy();
    if ((allowOnce && foreground()) || preference === "always") {
      show({ remote: { phase: "authorized", sequence: data.sequence } });
      return { ...fields(data.sequence), allowed: true };
    }
    return new Promise<z.infer<typeof videoReply>>((resolve) => {
      const cancel = () => settle(false);
      const settle = (allowed: boolean) => {
        clearTimeout(pending?.timer);
        request?.removeEventListener("abort", cancel);
        pending = undefined;
        show({
          remote: allowed
            ? { phase: "authorized", sequence: data.sequence }
            : { phase: "off" },
        });
        resolve({ ...fields(data.sequence), allowed });
      };
      pending = { settle, timer: setTimeout(() => settle(false), timeout) };
      request?.addEventListener("abort", cancel, { once: true });
      show({
        remote: {
          phase: "requesting",
          sequence: data.sequence,
          savedContact: preference !== "unknown",
        },
      });
    });
  }

  return {
    enable,
    disable: () => disable(),
    suspendCamera: () => {
      if (local) disable("background");
    },
    close,
    initialize: () => show({}),
    async switchCamera() {
      if (!local?.capture || !("url" in state.local) || switchInFlight) return;
      const attempt = local;
      const next = state.local.facing === "front" ? "back" : "front";
      switchInFlight = true;
      try {
        await local.capture.switchTo(next);
        if (local === attempt && "url" in state.local)
          show({ local: { ...state.local, facing: next }, error: null });
      } catch {
        if (local === attempt) show({ error: "switch" });
      } finally {
        switchInFlight = false;
      }
    },
    respond(sequence: number, decision: VideoDecision) {
      if (
        closed ||
        state.remote.phase !== "requesting" ||
        state.remote.sequence !== sequence ||
        !pending
      )
        return;
      if (decision === "allow-always") {
        try {
          if (policy() === "unknown" || !allowAlways())
            throw new Error("No saved contact");
        } catch {
          show({ error: "preference" });
          return;
        }
      }
      if (state.error === "preference") show({ error: null });
      if (decision !== "deny") allowOnce = true;
      pending.settle(decision !== "deny");
    },
    receiveOffer,
    receiveStop(payload: unknown) {
      const { data } = videoStop.safeParse(payload);
      if (!data || data.callId !== callId || data.sequence < remoteSequence)
        return;
      remoteSequence = data.sequence;
      resetRemote();
    },
    canReceive(payload: unknown) {
      const { data } = cameraMetadata.safeParse(payload);
      return (
        !closed &&
        !!data &&
        data.callId === callId &&
        (state.remote.phase === "authorized" ||
          state.remote.phase === "receiving") &&
        state.remote.sequence === data.sequence
      );
    },
    received(sequence: number, url: string) {
      if (
        state.remote.phase === "authorized" &&
        state.remote.sequence === sequence
      )
        show({ remote: { phase: "receiving", sequence, url } });
    },
    confirmFrames(payload: unknown) {
      const { data } = cameraMetadata.safeParse(payload);
      if (
        !data ||
        data.callId !== callId ||
        local?.sequence !== data.sequence ||
        state.local.phase !== "sending"
      )
        return;
      clearTimeout(local.frameDeadline);
      show({ local: { ...state.local, phase: "sharing" } });
    },
    interrupted(sequence: number) {
      if (
        state.remote.phase === "receiving" &&
        state.remote.sequence === sequence
      )
        show({ remote: { phase: "authorized", sequence }, stage: "remote" });
    },
    swap() {
      const layout = videoLayout(state);
      if (layout.stageUrl && layout.previewUrl)
        show({ stage: layout.source === "remote" ? "local" : "remote" });
    },
    setCorner(corner: VideoState["corner"]) {
      show({ corner });
    },
  };
}
