import { type EventSubscription, requireOptionalNativeModule } from "expo";
import { Image } from "expo-image";
import { Platform } from "react-native";
import { z } from "zod";
import { createStore } from "zustand/vanilla";
import { i18n } from "@/i18n";
import {
  type AudioRoute,
  audioRoute,
  type createCallController,
  type Routing,
} from "./controller";
import { systemCallCommand, systemRemoteVideo } from "./system-call-state";

type CallLabels = {
  channel: string;
  privateCaller: string;
  connecting: string;
  ongoing: string;
};

type NativeSystemCalling = {
  start(
    id: string,
    name: string,
    incoming: boolean,
    privateMode: boolean,
    labels: CallLabels,
  ): Promise<boolean>;
  update(id: string, answeredAt: number, privateMode: boolean): Promise<void>;
  setAvatar(id: string, cachedFile: string): Promise<void>;
  setRemoteVideo(id: string, url: string | null): Promise<void>;
  route(id: string, route: AudioRoute): Promise<boolean>;
  end(id: string): Promise<void>;
  addListener(
    event: "onCallEvent" | "onCallRoutes",
    listener: (payload: unknown) => void,
  ): EventSubscription;
};
const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<NativeSystemCalling>("BoopSystemCalling")
    : null;

const routes = z.object({
  callId: z.string(),
  selected: audioRoute.nullable(),
  available: audioRoute.array(),
});

export async function openTelecomAudio({
  id,
  name,
  avatarUrl,
  incoming,
  privateMode,
  signal,
  onRouting,
}: {
  id: string;
  name: string;
  avatarUrl?: string | null;
  incoming: boolean;
  privateMode: boolean;
  signal: AbortSignal;
  onRouting: (routing: Routing) => void;
}) {
  if (!native) return null;
  const system = native;
  signal.throwIfAborted();
  const routing = system.addListener("onCallRoutes", (payload) => {
    const state = routes.safeParse(payload).data;
    if (state?.callId === id)
      onRouting({ selected: state.selected, available: state.available });
  });
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    routing.remove();
    signal.removeEventListener("abort", close);
    void system.end(id).catch(() => undefined);
  }
  signal.addEventListener("abort", close, { once: true });
  const t = i18n.getFixedT(null, "calls");
  const started = await system
    .start(id, name, incoming, privateMode, {
      channel: t("ongoingChannel"),
      privateCaller: t("privateCaller"),
      connecting: i18n.t("connecting", { ns: "connections" }),
      ongoing: t("ongoing"),
    })
    .catch(() => false);
  if (!started || signal.aborted) {
    close();
    signal.throwIfAborted();
    return null;
  }
  if (avatarUrl && !privateMode) {
    void Image.getCachePathAsync(avatarUrl)
      .then((file) =>
        file && !closed ? system.setAvatar(id, file) : undefined,
      )
      .catch(() => undefined);
  }
  return {
    async route(value: AudioRoute) {
      if (!closed && !(await system.route(id, value)))
        throw new Error("Audio endpoint unavailable");
    },
    close,
  };
}

type Controller = ReturnType<typeof createCallController>;

export function attachSystemPresentation(
  calling: Controller,
  privacy: {
    privateMode(): boolean;
    subscribe(listener: () => void): () => void;
  },
) {
  const nativeOpen = createStore<{ id: string | null }>(() => ({ id: null }));
  if (!native) return nativeOpen;
  const system = native;
  let previous:
    | { id: string; time: number; video: string | null; privateMode: boolean }
    | undefined;
  const sync = () => {
    const { call, video } = calling.store.getState();
    if (!call || call.phase === "ended" || call.phase === "ending") {
      previous = undefined;
      nativeOpen.setState({ id: null });
      return;
    }
    const privateMode = privacy.privateMode();
    const next = {
      id: call.id,
      time: call.phase === "connected" ? call.answeredAt : 0,
      video: systemRemoteVideo(call, video, privateMode),
      privateMode,
    };
    const old = previous;
    previous = next;
    if (
      old?.id !== next.id ||
      old.time !== next.time ||
      old.privateMode !== privateMode
    ) {
      void system
        .update(next.id, next.time, privateMode)
        .catch(() => undefined);
    }
    if (old?.id !== next.id || old.video !== next.video) {
      void system.setRemoteVideo(next.id, next.video).catch(() => undefined);
    }
  };
  calling.store.subscribe(sync);
  privacy.subscribe(sync);
  system.addListener("onCallEvent", (payload) => {
    const event = systemCallCommand(calling.store.getState().call, payload);
    if (event?.kind === "end") calling.end();
    if (event?.kind === "failure") calling.systemInterrupted(event.callId);
    if (event?.kind === "open" || event?.kind === "pip-close")
      nativeOpen.setState({ id: event.callId });
  });
  return nativeOpen;
}
