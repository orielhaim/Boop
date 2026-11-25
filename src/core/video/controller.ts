import { createStore } from "zustand/vanilla";
import type { VideoPlayer } from "expo-video";
import type { AcquireOptions } from "@/core/media/sources";
import { mediaId, type MediaHandle } from "@/core/media/source";
import type { createVideoEngine } from "./engine";
import type { VideoPreferences, VideoSource } from "./types";
import type { LocalCaptions } from "./subtitles";

export type VideoPresentation = "full" | "floating" | "inline";
export type VideoNeighbors = { previous?: () => void; next?: () => void };

type SessionView = {
  id: number;
  source: VideoSource;
  player?: VideoPlayer;
  presentation: VideoPresentation;
  background: boolean;
  allowPiP: boolean;
  allowBackground: boolean;
  canExport: boolean;
  neighbors?: VideoNeighbors;
  captions?: LocalCaptions;
  suspended?: boolean;
};

type SuspendedVideo = {
  view: SessionView;
  position: number;
  dispose?: () => void;
};

type Playback = {
  view: SessionView;
  abort: AbortController;
  engine?: ReturnType<typeof createVideoEngine>;
  handle?: MediaHandle;
  subscriptions: { remove(): void }[];
  exports: Set<Promise<void>>;
  expiry?: ReturnType<typeof setTimeout>;
  backgroundPause?: ReturnType<typeof setTimeout>;
  completed: boolean;
  pip: boolean;
  lastCheckpoint: number;
  dispose?: () => void;
};

export function createVideoController(deps: {
  acquire(source: VideoSource, options: AcquireOptions): Promise<MediaHandle>;
  engine: typeof createVideoEngine;
  allowed(source: VideoSource): boolean;
  claim(): boolean;
  release(): void;
  handoff(
    handle: MediaHandle,
    action: "external" | "share" | "save",
    signal: AbortSignal,
  ): Promise<void>;
  preferences: VideoPreferences;
  savePreferences(value: VideoPreferences): void;
  position(id: string): number;
  checkpoint(id: string, seconds: number): void;
  listened?(source: VideoSource): void;
  genericTitle(): string;
}) {
  const store = createStore<{
    current?: SessionView;
    preferences: VideoPreferences;
  }>(() => ({
    preferences: deps.preferences,
  }));
  let current: Playback | undefined;
  let suspended: SuspendedVideo | undefined;
  let privateMode = false;
  let foreground = true;
  let pending = Promise.resolve();
  let sessionId = 0;
  const opening = new Set<Promise<boolean>>();
  const memoryListeners = new Set<() => void>();

  function valid(session: Playback) {
    return (
      current === session &&
      !session.abort.signal.aborted &&
      deps.allowed(session.view.source) &&
      (session.handle?.expiresAt == null ||
        session.handle.expiresAt > Date.now())
    );
  }

  function checkpoint(session: Playback) {
    const { player, source } = session.view;
    if (
      !player ||
      !store.getState().preferences.rememberPosition ||
      source.round ||
      session.handle?.expiresAt !== null
    )
      return;
    const seconds = player.currentTime;
    if (!Number.isFinite(seconds)) return;
    try {
      deps.checkpoint(
        mediaId(source),
        session.completed || seconds < 2 ? 0 : seconds,
      );
    } catch {
      // Persistence must never keep a decoder or its decrypted lease alive.
    }
    session.lastCheckpoint = Date.now();
  }

  function publish(session: Playback, update: Partial<SessionView>) {
    session.view = { ...session.view, ...update };
    store.setState({ current: session.view });
  }

  function close(retain?: SuspendedVideo) {
    const previous = suspended;
    suspended = retain;
    const session = current;
    if (!session) {
      if (previous && previous !== retain) {
        store.setState({ current: undefined });
        pending = pending
          .then(() => previous.dispose?.())
          .catch(() => undefined);
      }
      return pending;
    }
    current = undefined;
    session.abort.abort();
    clearTimeout(session.expiry);
    clearTimeout(session.backgroundPause);
    deps.release();
    for (const subscription of session.subscriptions) subscription.remove();
    if (session.engine) {
      session.engine.stop();
      checkpoint(session);
    }
    store.setState({ current: retain?.view });
    const cleanup = async () => {
      try {
        await session.engine?.close();
      } finally {
        await Promise.allSettled(session.exports);
        await session.handle?.release();
        if (!retain) session.dispose?.();
      }
    };
    pending = pending.then(cleanup).catch(() => undefined);
    return pending;
  }

  function refreshPolicy(session: Playback) {
    const player = session.engine?.player;
    if (!player) return;
    const { presentation, background } = session.view;
    player.keepScreenOnWhilePlaying =
      foreground && !session.pip && !background && presentation === "full";
    player.staysActiveInBackground = background;
    player.showNowPlayingNotification =
      !privateMode &&
      session.view.canExport &&
      (foreground || session.pip || background);
  }

  async function startSession(
    source: VideoSource,
    options: {
      download?: boolean;
      dispose?: () => void;
      neighbors?: VideoNeighbors;
      restore?: SuspendedVideo;
    } = {},
  ) {
    const { restore } = options;
    if (!foreground || !deps.allowed(source)) {
      if (restore) store.setState({ current: undefined });
      if (restore) await pending;
      options.dispose?.();
      return false;
    }
    const external =
      !restore && !source.round && store.getState().preferences.external;
    if (
      current &&
      mediaId(current.view.source) === mediaId(source) &&
      current.view.player &&
      !(external && current.view.canExport)
    ) {
      options.dispose?.();
      if (!source.round) present("full");
      return true;
    }
    const retired = close();
    if (!deps.claim()) {
      if (restore) store.setState({ current: undefined });
      if (restore) await retired;
      options.dispose?.();
      return false;
    }
    const session: Playback = {
      view: {
        id: ++sessionId,
        source,
        presentation: source.round ? "inline" : "full",
        background: false,
        allowPiP: false,
        allowBackground: false,
        canExport: false,
        neighbors: options.neighbors,
        captions: restore?.view.captions,
      },
      abort: new AbortController(),
      subscriptions: [],
      exports: new Set(),
      completed: false,
      pip: false,
      lastCheckpoint: Date.now(),
      dispose: options.dispose,
    };
    current = session;
    if (!external && !options.download) publish(session, {});
    try {
      await retired;
      if (!valid(session) || !foreground) return false;
      const handle = await deps.acquire(source, {
        signal: session.abort.signal,
        download: options.download === true,
        invalidate: () => (current === session ? close() : pending),
      });
      if (!valid(session)) {
        await handle.release();
        return false;
      }
      session.handle = handle;
      if (!valid(session) || !foreground) return false;
      const canExport = handle.expiresAt === null && !source.round;
      if (external && canExport) {
        await exportFile("external");
        return true;
      }
      const engine = deps.engine();
      session.engine = engine;
      const { player } = engine;
      if (handle.expiresAt !== null) {
        const expire = () => {
          if (current === session) void close();
        };
        session.expiry = setTimeout(
          expire,
          Math.min(2_147_483_647, handle.expiresAt - Date.now()),
        );
      }
      let initialized = false;
      let listened = false;
      const start = () => {
        if (
          initialized ||
          !valid(session) ||
          !foreground ||
          player.status !== "readyToPlay"
        )
          return;
        if (!player.availableVideoTracks.length) return;
        initialized = true;
        if (restore) {
          if (Number.isFinite(restore.position))
            player.currentTime = Math.min(restore.position, player.duration);
        } else if (
          !source.round &&
          handle.expiresAt === null &&
          store.getState().preferences.rememberPosition
        ) {
          const saved = deps.position(mediaId(source));
          if (saved > 0 && saved < player.duration - 2)
            player.currentTime = saved;
        }
        if (!restore) player.play();
      };
      session.subscriptions.push(
        player.addListener("statusChange", start),
        player.addListener("sourceLoad", start),
        player.addListener("videoTrackChange", start),
        player.addListener("playbackDeadlineExpired", () => {
          if (current === session) void close();
        }),
        player.addListener("playToEnd", () => {
          if (!valid(session) || player.loop) return;
          session.completed = true;
          if (source.round) {
            void close();
            return;
          }
          checkpoint(session);
        }),
        player.addListener("playingChange", ({ isPlaying }) => {
          if (!valid(session)) return;
          if (isPlaying) {
            session.completed = false;
            if (source.round && !listened) {
              listened = true;
              deps.listened?.(source);
            }
          } else if (initialized) checkpoint(session);
        }),
        player.addListener("timeUpdate", () => {
          if (
            valid(session) &&
            !session.completed &&
            Date.now() - session.lastCheckpoint >= 15_000
          )
            checkpoint(session);
        }),
      );
      await engine.load(handle, deps.genericTitle());
      if (!valid(session)) return false;
      publish(session, {
        player,
        canExport,
        allowPiP: canExport && !privateMode,
        allowBackground: canExport && !privateMode,
      });
      refreshPolicy(session);
      start();
      return true;
    } catch {
      return false;
    } finally {
      if (current === session && !session.view.player) await close();
    }
  }

  function open(
    source: VideoSource,
    options?: Parameters<typeof startSession>[1],
  ) {
    const task = startSession(source, options);
    opening.add(task);
    void task.then(
      () => opening.delete(task),
      () => opening.delete(task),
    );
    return task;
  }

  async function exportFile(action: "external" | "share" | "save") {
    const session = current;
    if (
      !session ||
      !valid(session) ||
      !foreground ||
      session.handle?.expiresAt !== null ||
      session.view.source.round
    )
      return;
    session.engine?.player.pause();
    const task = deps.handoff(session.handle, action, session.abort.signal);
    session.exports.add(task);
    try {
      await task;
    } finally {
      session.exports.delete(task);
    }
  }

  function present(presentation: Exclude<VideoPresentation, "inline">) {
    const session = current;
    if (!session || !valid(session) || session.view.source.round) return;
    if (
      presentation === "floating" &&
      store.getState().preferences.pipMode === "off"
    )
      return;
    publish(session, { presentation });
    refreshPolicy(session);
  }

  function pauseIfStillBackgrounded(session: Playback) {
    clearTimeout(session.backgroundPause);
    session.backgroundPause = setTimeout(() => {
      if (
        current === session &&
        !foreground &&
        !session.pip &&
        !session.view.background
      )
        session.view.player?.pause();
    }, 750);
  }

  return {
    store,
    memoryWarning() {
      for (const listener of memoryListeners) listener();
    },
    onMemoryWarning(listener: () => void) {
      memoryListeners.add(listener);
      return () => {
        memoryListeners.delete(listener);
      };
    },
    open,
    close: () => close(),
    async drain() {
      await close();
      await Promise.allSettled(opening);
    },
    present,
    captions(owner: VideoPlayer, captions?: LocalCaptions) {
      const session = current;
      if (!session || session.view.player !== owner || !valid(session)) return;
      if (captions) owner.subtitleTrack = null;
      publish(session, { captions });
    },
    exportFile,
    preferences(patch: Partial<VideoPreferences>) {
      const preferences = { ...store.getState().preferences, ...patch };
      store.setState({ preferences });
      deps.savePreferences(preferences);
      if (
        preferences.pipMode === "off" &&
        current?.view.presentation === "floating"
      ) {
        void close();
        return;
      }
      if (!preferences.allowBackground && current?.view.background) {
        publish(current, { background: false });
        refreshPolicy(current);
      }
    },
    background(active: boolean) {
      const session = current;
      if (
        !session ||
        !session.view.canExport ||
        privateMode ||
        (active && !store.getState().preferences.allowBackground)
      )
        return;
      publish(session, { background: active });
      refreshPolicy(session);
    },
    pictureInPicture(owner: VideoPlayer, active: boolean) {
      if (current?.view.player !== owner) return;
      const session = current;
      if (
        active &&
        (!session.view.allowPiP ||
          store.getState().preferences.pipMode !== "system")
      ) {
        void close();
        return;
      }
      session.pip = active;
      clearTimeout(session.backgroundPause);
      refreshPolicy(session);
      // Android can notify PiP exit before React Native reports foreground entry.
      if (!active && !foreground && !session.view.background)
        pauseIfStillBackgrounded(session);
    },
    privacy(state: { enabled: boolean; locked: boolean; active: boolean }) {
      privateMode = state.enabled;
      foreground = state.active;
      const session = current;
      const covered = state.locked || (privateMode && !foreground);
      if (!session) {
        if (suspended && foreground && !covered) {
          const restore = suspended;
          suspended = undefined;
          return open(restore.view.source, {
            restore,
            neighbors: restore.view.neighbors,
            dispose: restore.dispose,
          });
        }
        return;
      }
      clearTimeout(session.backgroundPause);
      if (covered || (privateMode && session.pip)) {
        const { view } = session;
        if (
          view.presentation === "full" &&
          view.player &&
          view.canExport &&
          !view.background
        ) {
          return close({
            view: {
              ...view,
              player: undefined,
              allowPiP: false,
              allowBackground: false,
              canExport: false,
              suspended: true,
            },
            position: view.player.currentTime,
            dispose: session.dispose,
          });
        }
        return close();
      }
      if (privateMode && (session.view.allowPiP || session.view.background))
        publish(session, {
          allowPiP: false,
          allowBackground: false,
          background: false,
        });
      if (!privateMode && session.view.canExport && !session.view.allowPiP)
        publish(session, { allowPiP: true, allowBackground: true });
      if (!foreground) {
        checkpoint(session);
        if (!session.pip && !session.view.background) {
          if (
            session.view.allowPiP &&
            store.getState().preferences.pipMode === "system" &&
            session.view.presentation !== "inline"
          )
            pauseIfStillBackgrounded(session);
          else session.view.player?.pause();
        }
      }
      refreshPolicy(session);
    },
    revalidate() {
      if (current && !valid(current)) void close();
    },
  };
}
