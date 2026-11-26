import { createStore } from "zustand/vanilla";
import type { VideoPlayer } from "expo-video";
import type { AcquireOptions } from "@/core/media/sources";
import {
  mediaId,
  type LocalMediaHandle,
  type MediaHandle,
} from "@/core/media/source";
import type { createVideoEngine } from "./engine";
import type { VideoPreferences, VideoSource } from "./types";
import { bindSubtitles, emptySubtitles } from "./subtitles/session";
import type { SubtitleEncoding } from "./subtitles/encoding";
import type {
  SubtitleInput,
  SubtitleSelection,
  SubtitleState,
} from "./subtitles/tracks";
import {
  defaultCaptionAppearance,
  type CaptionAppearance,
} from "./subtitles/types";

export type VideoPresentation = "full" | "floating";
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
  progressive: boolean;
  neighbors?: VideoNeighbors;
  subtitles: SubtitleState;
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
  subtitles?: ReturnType<typeof bindSubtitles>;
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
    handle: LocalMediaHandle,
    action: "external" | "share" | "save",
    signal: AbortSignal,
  ): Promise<void>;
  openCompleted?(
    id: string,
    consume: (handle: LocalMediaHandle) => Promise<void>,
  ): Promise<void>;
  preferences: VideoPreferences;
  savePreferences(value: VideoPreferences): void;
  position(id: string): number;
  checkpoint(id: string, seconds: number): void;
  captionPreferences?: {
    appearance: CaptionAppearance;
    saveAppearance(value: CaptionAppearance): void;
    offset(id: string): number;
    saveOffset(id: string, offset: number): void;
  };
  genericTitle(): string;
}) {
  const store = createStore<{
    current?: SessionView;
    preferences: VideoPreferences;
    captionAppearance: CaptionAppearance;
  }>(() => ({
    preferences: deps.preferences,
    captionAppearance:
      deps.captionPreferences?.appearance ?? defaultCaptionAppearance,
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
    session.subtitles?.close();
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
        if (session.handle?.kind === "progressive")
          await session.handle.cancelReads().catch(() => undefined);
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
      session.handle?.expiresAt === null &&
      (foreground || session.pip || background);
  }

  async function startSession(
    source: VideoSource,
    options: {
      download?: boolean;
      openInBoop?: true;
      progressive?: boolean;
      replace?: boolean;
      dispose?: () => void;
      neighbors?: VideoNeighbors;
      restore?: SuspendedVideo;
      relatedSubtitles?: (signal: AbortSignal) => Promise<SubtitleInput[]>;
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
      !restore && !options.openInBoop && store.getState().preferences.external;
    if (
      current &&
      !options.replace &&
      mediaId(current.view.source) === mediaId(source) &&
      (current.view.player || current.view.progressive) &&
      !(external && current.view.canExport)
    ) {
      options.dispose?.();
      present("full");
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
        presentation: "full",
        background: false,
        allowPiP: false,
        allowBackground: false,
        canExport: false,
        progressive: options.progressive === true,
        neighbors: options.neighbors,
        subtitles: emptySubtitles,
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
    if ((!external && !options.download) || options.progressive)
      publish(session, {});
    try {
      await retired;
      if (!valid(session) || !foreground) return false;
      const handle = await deps.acquire(source, {
        signal: session.abort.signal,
        download: options.download === true,
        progressive: options.progressive === true,
        invalidate: () => (current === session ? close() : pending),
      });
      if (!valid(session)) {
        await handle.release();
        return false;
      }
      session.handle = handle;
      if (!valid(session) || !foreground) return false;
      const canExport = handle.kind === "local" && handle.expiresAt === null;
      const unrestricted = handle.expiresAt === null;
      if (external && canExport && !options.progressive) {
        await exportFile("external");
        return true;
      }
      const engine = deps.engine();
      session.engine = engine;
      const { player } = engine;
      const { expiresAt } = handle;
      if (expiresAt !== null) {
        const watchExpiry = () => {
          session.expiry = setTimeout(
            () => {
              if (current !== session) return;
              if (Date.now() >= expiresAt) void close();
              else watchExpiry();
            },
            Math.max(0, Math.min(2_147_483_647, expiresAt - Date.now())),
          );
        };
        watchExpiry();
      }
      let initialized = false;
      let prepared = false;
      const start = () => {
        if (
          initialized ||
          !prepared ||
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
          checkpoint(session);
        }),
        player.addListener("playingChange", ({ isPlaying }) => {
          if (!valid(session)) return;
          if (isPlaying) session.completed = false;
          else if (initialized) checkpoint(session);
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
      const id = mediaId(source);
      session.subtitles = bindSubtitles(player, {
        active: () => valid(session),
        allowExternal: unrestricted,
        initialOffset: unrestricted
          ? (deps.captionPreferences?.offset(id) ?? 0)
          : 0,
        saveOffset: (offset) => {
          if (unrestricted) deps.captionPreferences?.saveOffset(id, offset);
        },
        publish: (subtitles) => publish(session, { subtitles }),
        appearance: () => store.getState().captionAppearance,
      });
      if (unrestricted && options.relatedSubtitles) {
        const inputs = await options
          .relatedSubtitles(session.abort.signal)
          .catch(() => []);
        if (!valid(session)) return false;
        if (foreground && session.subtitles.add(inputs))
          await session.subtitles.settled();
        if (!valid(session)) return false;
      }
      prepared = true;
      publish(session, {
        player,
        subtitles: session.subtitles.state,
        canExport,
        progressive: handle.kind === "progressive",
        allowPiP: unrestricted && !privateMode,
        allowBackground: unrestricted && !privateMode,
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
      session.handle?.expiresAt !== null
    )
      return;
    const handoff = async (handle: LocalMediaHandle) => {
      if (valid(session) && foreground) {
        session.engine?.player.pause();
        await deps.handoff(handle, action, session.abort.signal);
      }
    };
    const task =
      session.handle.kind === "local"
        ? handoff(session.handle)
        : (deps.openCompleted?.(session.handle.sourceId, handoff) ??
          Promise.resolve());
    session.exports.add(task);
    try {
      await task;
    } finally {
      session.exports.delete(task);
    }
  }

  function present(presentation: VideoPresentation) {
    const session = current;
    if (!session || !valid(session)) return;
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
    subtitleImportSignal(owner: VideoPlayer) {
      const session = current;
      if (
        session?.view.player === owner &&
        session.handle?.expiresAt === null &&
        valid(session)
      )
        return session.abort.signal;
    },
    addSubtitles(owner: VideoPlayer, inputs: SubtitleInput[]) {
      return foreground && current?.view.player === owner
        ? (current.subtitles?.add(inputs) ?? 0)
        : 0;
    },
    selectSubtitle(owner: VideoPlayer, selection: SubtitleSelection) {
      if (current?.view.player === owner) current.subtitles?.select(selection);
    },
    removeSubtitle(owner: VideoPlayer, id: number) {
      if (current?.view.player === owner) current.subtitles?.remove(id);
    },
    subtitleEncoding(
      owner: VideoPlayer,
      id: number,
      encoding: SubtitleEncoding,
    ) {
      return current?.view.player === owner
        ? (current.subtitles?.encoding(id, encoding) ?? false)
        : false;
    },
    subtitleOffset(owner: VideoPlayer, offset: number) {
      if (current?.view.player === owner) current.subtitles?.offset(offset);
    },
    captionAppearance(appearance: CaptionAppearance) {
      store.setState({ captionAppearance: appearance });
      deps.captionPreferences?.saveAppearance(appearance);
      current?.subtitles?.appearanceChanged();
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
        !session.view.allowBackground ||
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
            progressive: restore.view.progressive,
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
              subtitles: emptySubtitles,
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
      if (
        !privateMode &&
        session.handle?.expiresAt === null &&
        !session.view.allowPiP
      )
        publish(session, { allowPiP: true, allowBackground: true });
      if (!foreground) {
        checkpoint(session);
        if (!session.pip && !session.view.background) {
          if (
            session.view.allowPiP &&
            store.getState().preferences.pipMode === "system"
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
    retireProgressive() {
      if (current?.view.progressive) return close();
    },
  };
}
