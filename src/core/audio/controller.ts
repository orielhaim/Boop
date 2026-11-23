import { PlaybackDownloadCancelled } from "./download";
import { createStore } from "zustand/vanilla";
import {
  initialPlayback,
  speeds,
  trackId,
  trackSchema,
  type SavedPlayback,
  type Speed,
  type Track,
} from "./types";

export type Metadata = {
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  duration?: number;
};
export type AudioStatus = {
  position: number;
  duration: number;
  playing: boolean;
  ended?: boolean;
  failed?: boolean;
};
export type AudioHandle = {
  uri: string;
  metadata?: Metadata;
  release(): Promise<void>;
};
export type Commands = {
  status(status: AudioStatus): void;
  next(): void;
  previous(): void;
  stop(): void;
};
export type AudioEngine = {
  ready(signal: AbortSignal): Promise<void>;
  snapshot(): Pick<AudioStatus, "position" | "playing">;
  play(): void;
  pause(): void;
  seek(position: number): Promise<void>;
  speed(speed: Speed): void;
  controls(metadata: Metadata | null, voice: boolean): void;
  close(keepSession?: boolean): void;
};
type Current = {
  track: Track;
  position: number;
  duration: number;
  phase: "restored" | "loading" | "playing" | "paused" | "error";
  metadata?: Metadata;
};
type PausedMusic = Current & { phase: "paused"; speed: Speed };
export function playerPlayback(state: {
  current?: Current;
  pausedMusic?: PausedMusic;
}) {
  return state.pausedMusic ?? state.current;
}

type Session = {
  track: Track;
  abort: AbortController;
  handle?: AudioHandle;
  engine?: AudioEngine;
  expiry?: ReturnType<typeof setTimeout>;
  started: boolean;
  ended: boolean;
  listened: boolean;
};
type Preferences = { external: boolean; voiceSpeed: Speed };
type Dependencies = {
  saved?: SavedPlayback;
  save(value: SavedPlayback): void;
  preferences: Preferences;
  savePreferences(value: Preferences): void;
  acquire(
    track: Track,
    options: { signal: AbortSignal; download: boolean; invalidate(): void },
  ): Promise<AudioHandle>;
  setup(): Promise<void>;
  engine(
    uri: string,
    commands: Commands,
    expiresAt: number | null,
    isolated?: boolean,
  ): AudioEngine;
  disposeEngine?(): void;
  allowed(track: Track): boolean;
  listened(track: Track): void;
  genericTitle(): string;
};

export function createAudioController(deps: Dependencies) {
  const saved = deps.saved ?? initialPlayback;
  const store = createStore(() => ({
    current: saved.current
      ? current(saved.current.track, saved.current.position, "restored")
      : undefined,
    upcoming: saved.upcoming,
    history: saved.history,
    repeat: saved.repeat,
    shuffle: saved.shuffle,
    preferences: deps.preferences,
    speed: saved.current?.track.voice ? deps.preferences.voiceSpeed : speeds[1],
    blocked: false,
    preparingVoice: undefined as string | undefined,
    pausedMusic: undefined as PausedMusic | undefined,
  }));
  const get = store.getState;
  const set = store.setState;
  let music = saved.music;
  let resumeMusic = false;
  let privateMode = false;
  let locked = false;
  let call = false;
  const recording = new Set<symbol>();
  const defaultRecorder = Symbol("recorder");
  let activeSession: Session | undefined;
  let preparing: Session | undefined;
  let suspended: Session | undefined;
  let handoff: AbortController | undefined;
  let voiceInterlude =
    saved.voiceInterlude ?? Boolean(saved.current?.track.voice);
  let lastSavedPosition = saved.current?.position ?? 0;
  const inFlight = new Set<Promise<unknown>>();

  function current(
    track: Track,
    position: number,
    phase: Current["phase"],
  ): Current {
    return { track, phase, position, duration: track.duration ?? 0 };
  }

  function eligible(track: Track) {
    const expires = track.kind === "attachment" ? track.source.expiresAt : null;
    return (expires === null || expires > Date.now()) && deps.allowed(track);
  }

  function persist() {
    const { current, upcoming, history, repeat, shuffle } = get();
    lastSavedPosition = current?.position ?? 0;
    deps.save({
      current: current && { track: current.track, position: current.position },
      music,
      voiceInterlude,
      upcoming,
      history,
      repeat,
      shuffle,
    });
  }

  function trackWork<T>(work: Promise<T>) {
    inFlight.add(work);
    void work.then(
      () => inFlight.delete(work),
      () => inFlight.delete(work),
    );
    return work;
  }

  function release(session: Session | undefined, keepSession = false) {
    if (!session) return;
    session.abort.abort();
    clearTimeout(session.expiry);
    session.engine?.close(keepSession);
    if (session.handle)
      trackWork(session.handle.release().catch(() => undefined));
  }

  function detach(keepSession = false) {
    const session = activeSession;
    activeSession = undefined;
    release(session, keepSession);
    if (!keepSession) deps.disposeEngine?.();
  }

  function cancelVoice(id?: string) {
    if (!preparing || (id !== undefined && trackId(preparing.track) !== id))
      return false;
    const session = preparing;
    preparing = undefined;
    release(session);
    set({ preparingVoice: undefined });
    return true;
  }

  function releaseSuspended() {
    const session = suspended;
    if (!session) return;
    suspended = undefined;
    release(session);
    set({ pausedMusic: undefined });
  }

  function controls() {
    const active = get().current;
    const engine = activeSession?.engine;
    if (!engine || !active) return;
    const { track, metadata } = active;
    engine.controls(
      get().blocked
        ? null
        : privateMode
          ? { title: deps.genericTitle() }
          : {
              title: metadata?.title || track.title || deps.genericTitle(),
              artist: metadata?.artist || track.subtitle,
              album: metadata?.album,
              artworkUrl: metadata?.artworkUrl,
            },
      track.voice,
    );
  }

  function stop() {
    finishQueue();
  }

  function finishQueue(keepVoice = false) {
    handoff?.abort();
    if (!keepVoice) cancelVoice();
    detach();
    releaseSuspended();
    resumeMusic = false;
    voiceInterlude = false;
    const { upcoming } = get();
    const interrupted = music?.track;
    set({
      current: undefined,
      upcoming:
        interrupted && eligible(interrupted)
          ? [
              interrupted,
              ...upcoming.filter(
                (item) => trackId(item) !== trackId(interrupted),
              ),
            ].slice(0, 500)
          : upcoming,
    });
    persist();
  }

  function invalidate(track: Track) {
    const id = trackId(track);
    const { current, upcoming, history } = get();
    cancelVoice(id);
    if (music && trackId(music.track) === id) {
      releaseSuspended();
      music = undefined;
    }
    set({
      upcoming: upcoming.filter((item) => trackId(item) !== id),
      history: history.filter((item) => trackId(item) !== id),
    });
    if (current && trackId(current.track) === id) stop();
    else persist();
  }

  function watchExpiry(session: Session) {
    const { track } = session;
    const until = track.kind === "attachment" ? track.source.expiresAt : null;
    if (until === null) return;
    session.expiry = setTimeout(
      () => {
        if (Date.now() >= until) invalidate(track);
        else watchExpiry(session);
      },
      Math.max(0, Math.min(2 ** 31 - 1, until - Date.now())),
    );
  }

  function owns(session: Session) {
    return (
      !session.abort.signal.aborted &&
      (session === activeSession ||
        session === preparing ||
        session === suspended)
    );
  }

  function valid(session: Session) {
    return owns(session) && !get().blocked && eligible(session.track);
  }

  function newSession(track: Track): Session {
    return {
      track,
      abort: new AbortController(),
      started: false,
      ended: false,
      listened: false,
    };
  }

  function restoreMusic(shouldResume = resumeMusic) {
    const parked = suspended;
    const player = parked?.engine;
    const { pausedMusic, blocked } = get();
    if (
      !parked ||
      !player ||
      !pausedMusic ||
      blocked ||
      !eligible(pausedMusic.track)
    )
      return false;
    detach();
    suspended = undefined;
    music = undefined;
    resumeMusic = false;
    voiceInterlude = false;
    activeSession = parked;
    const { speed, ...current } = pausedMusic;
    set({ current, speed, pausedMusic: undefined });
    controls();
    if (shouldResume) player.play();
    persist();
    return true;
  }

  function failSession(session: Session) {
    if (activeSession !== session) return;
    if (session.track.voice && restoreMusic()) return;
    const active = get().current;
    detach();
    if (active) set({ current: { ...active, phase: "error" } });
    persist();
  }

  function updateStatus(session: Session, status: AudioStatus) {
    const active = get().current;
    if (activeSession !== session || !active) return;
    const { track } = session;
    if (!eligible(track)) {
      invalidate(track);
      return;
    }
    if (status.failed) {
      failSession(session);
      return;
    }
    if (!session.started) return;
    if (status.ended && !session.ended) {
      session.ended = true;
      void next(true);
      return;
    }
    if (status.playing) session.ended = false;
    const phase = status.playing ? "playing" : "paused";
    const duration = status.duration > 0 ? status.duration : active.duration;
    if (
      active.position !== status.position ||
      active.phase !== phase ||
      active.duration !== duration
    ) {
      set({
        current: { ...active, phase, position: status.position, duration },
      });
      if (
        Math.abs(status.position - lastSavedPosition) >= 5 ||
        active.phase !== phase
      )
        persist();
    }
    if (status.playing && !session.listened) {
      session.listened = true;
      deps.listened(track);
    }
  }

  async function acquireEngine(
    session: Session,
    download: boolean,
    isolated = false,
  ) {
    const { track } = session;
    const source = await deps.acquire(track, {
      signal: session.abort.signal,
      download,
      invalidate: () => {
        if (owns(session)) invalidate(track);
      },
    });
    if (!valid(session)) {
      await source.release();
      if (owns(session)) invalidate(track);
      return;
    }
    session.handle = source;
    // The music session has already configured the system audio mode.
    if (!isolated) await deps.setup();
    if (!valid(session)) {
      if (owns(session)) invalidate(track);
      return;
    }
    const player = deps.engine(
      source.uri,
      {
        status: (status) => updateStatus(session, status),
        next: () => {
          if (activeSession === session) void next();
        },
        previous: () => {
          if (activeSession === session) void previous();
        },
        stop: () => {
          if (activeSession === session) stop();
        },
      },
      track.kind === "attachment" ? track.source.expiresAt : null,
      isolated,
    );
    if (!valid(session)) {
      player.close();
      if (owns(session)) invalidate(track);
      return;
    }
    session.engine = player;
    return player;
  }

  function begin(session: Session, player: AudioEngine, position: number) {
    const { track } = session;
    const metadata = session.handle?.metadata;
    const entry = current(track, position, "loading");
    set({
      current: {
        ...entry,
        track: metadata?.duration
          ? { ...track, duration: metadata.duration }
          : track,
        duration: metadata?.duration || entry.duration,
        metadata,
      },
      speed: track.voice ? get().preferences.voiceSpeed : 1,
    });
    persist();
    player.speed(get().speed);
    controls();
    session.started = true;
    player.play();
  }

  async function load(track: Track, position: number, download: boolean) {
    if (get().blocked || !eligible(track)) return false;
    detach(!download);
    const session = newSession(track);
    activeSession = session;
    set({
      current: current(track, position, "loading"),
      speed: track.voice ? get().preferences.voiceSpeed : 1,
    });
    persist();
    watchExpiry(session);
    try {
      const player = await acquireEngine(session, download);
      if (!player) return false;
      if (position > 0) await player.seek(position);
      if (!valid(session)) {
        if (owns(session)) invalidate(track);
        return false;
      }
      begin(session, player, position);
      return true;
    } catch (error) {
      if (activeSession === session) {
        if (error instanceof PlaybackDownloadCancelled) stop();
        else failSession(session);
      }
      return false;
    }
  }

  async function prepareInterlude(track: Track, download: boolean) {
    const session = newSession(track);
    preparing = session;
    set({ preparingVoice: trackId(track) });
    watchExpiry(session);
    try {
      const voice = await acquireEngine(session, download, true);
      if (!voice) return false;
      await voice.ready(session.abort.signal);
      if (!valid(session)) return false;

      const active = get().current;
      const playingSession = activeSession;
      const player = playingSession?.engine;
      let pausedMusic: PausedMusic | undefined;
      if (active?.track.voice) return false;
      if (active) {
        const status = player?.snapshot();
        const position =
          status && Number.isFinite(status.position)
            ? status.position
            : active.position;
        music = { track: active.track, position };
        resumeMusic = Boolean(status?.playing || active.phase === "loading");
        if (playingSession?.started && player) {
          suspended = playingSession;
          pausedMusic = {
            ...active,
            phase: "paused",
            position,
            speed: get().speed,
          };
        } else detach();
      }
      activeSession = session;
      preparing = undefined;
      voiceInterlude = true;
      if (suspended) {
        player?.pause();
        player?.controls(null, false);
      }
      set({
        pausedMusic,
        preparingVoice: undefined,
        upcoming: get().upcoming.filter(
          (item) => trackId(item) !== trackId(track),
        ),
      });
      begin(session, voice, 0);
      return true;
    } catch (error) {
      if (activeSession === session) failSession(session);
      else if (
        preparing !== session ||
        error instanceof PlaybackDownloadCancelled
      )
        return false;
      throw error;
    } finally {
      if (preparing === session) cancelVoice();
    }
  }

  function start(
    track: Track,
    position = 0,
    download = false,
    keepVoice = false,
  ) {
    if (!keepVoice || track.voice) cancelVoice();
    if (!track.voice) releaseSuspended();
    return trackWork(load(track, position, download));
  }

  function addHistory(track: Track) {
    const id = trackId(track);
    set({
      history: [
        ...get().history.filter((item) => trackId(item) !== id),
        track,
      ].slice(-100),
    });
  }

  async function play(input: Track, download = false) {
    const track = trackSchema.parse(input);
    handoff?.abort();
    if (get().blocked || !eligible(track)) return false;
    if (get().preparingVoice === trackId(track)) return true;
    cancelVoice();
    const parked = get().pausedMusic;
    if (parked && trackId(parked.track) === trackId(track))
      return restoreMusic(true);
    const active = get().current;
    const engine = activeSession?.engine;
    if (active && trackId(active.track) === trackId(track)) {
      if (active.phase === "loading" || active.phase === "playing") return true;
      if (engine) {
        engine.play();
        return true;
      }
      return start(track, active.position, download);
    }
    if (track.voice && active && !active.track.voice && activeSession?.started)
      return trackWork(prepareInterlude(track, download));
    voiceInterlude = track.voice;
    if (active) {
      if (track.voice && !active.track.voice) {
        music = { track: active.track, position: active.position };
        resumeMusic = active.phase === "playing" || active.phase === "loading";
      } else if (!track.voice) {
        addHistory(active.track);
        if (music && trackId(music.track) !== trackId(track)) music = undefined;
        resumeMusic = false;
      }
    }
    set({
      upcoming: get().upcoming.filter(
        (item) => trackId(item) !== trackId(track),
      ),
    });
    return start(track, takeMusicPosition(track), download);
  }

  function takeMusicPosition(track: Track) {
    if (!music || trackId(music.track) !== trackId(track)) return 0;
    const { position } = music;
    music = undefined;
    resumeMusic = false;
    return position;
  }

  async function next(natural = false) {
    const { current, repeat, upcoming, history } = get();
    if (get().blocked) return;
    const keepVoice = natural && !current?.track.voice;
    if (natural && current?.track.voice && music) {
      if (restoreMusic()) return;
      const interrupted = music;
      music = undefined;
      const resume = resumeMusic;
      resumeMusic = false;
      if (resume && eligible(interrupted.track)) {
        voiceInterlude = false;
        await start(interrupted.track, interrupted.position, false);
        return;
      }
      music = interrupted;
    }
    if (natural && current?.track.voice && voiceInterlude) {
      stop();
      return;
    }
    voiceInterlude = false;
    if (natural && current && !current.track.voice && repeat === "one") {
      await start(current.track, 0, false, keepVoice);
      return;
    }
    let remaining = upcoming.filter(eligible);
    if (!natural && !remaining.length && repeat !== "all") {
      if (remaining.length !== upcoming.length) {
        set({ upcoming: remaining });
        persist();
      }
      return;
    }
    if (!remaining.length && repeat === "all" && !current?.track.voice) {
      const cycle = [...history, ...(current ? [current.track] : [])].filter(
        eligible,
      );
      remaining = [
        ...new Map(cycle.map((item) => [trackId(item), item])).values(),
      ];
      set({ history: [] });
    } else if (current) {
      addHistory(current.track);
    }
    if (remaining.length) {
      const [selected] = remaining.splice(0, 1);
      set({ upcoming: remaining });
      await start(selected, takeMusicPosition(selected), false, keepVoice);
      return;
    }
    set({ upcoming: remaining });
    finishQueue(keepVoice);
  }

  async function previous() {
    if (get().blocked) return;
    const { current, upcoming, history } = get();
    if (current && (current.position > 3 || !history.length)) {
      await seek(0);
      return;
    }
    const available = history.filter(eligible);
    const previous = available.pop();
    if (!previous) return;
    set({
      history: available,
      upcoming: current
        ? [
            current.track,
            ...upcoming.filter(
              (item) => trackId(item) !== trackId(current.track),
            ),
          ].slice(0, 500)
        : upcoming,
    });
    await start(previous, 0, false);
  }

  async function seek(position: number, fromPlayer = false) {
    const parked = fromPlayer ? get().pausedMusic : undefined;
    const active = parked ?? get().current;
    if (
      !active ||
      !Number.isFinite(position) ||
      active.duration <= 0 ||
      get().blocked
    )
      return;
    const value = Math.min(active.duration, Math.max(0, position));
    const engine = parked ? suspended?.engine : activeSession?.engine;
    if (parked) {
      music = { track: parked.track, position: value };
      set({ pausedMusic: { ...parked, position: value } });
    } else set({ current: { ...active, position: value } });
    persist();
    await engine?.seek(value).catch(() => undefined);
  }

  function toggle() {
    const active = get().current;
    if (!active || get().blocked) return;
    if (active.phase === "loading") stop();
    else if (active.phase === "playing") activeSession?.engine?.pause();
    else void play(active.track);
  }

  function speed(speed: Speed, fromPlayer = false) {
    if (!speeds.includes(speed)) return;
    const parked = fromPlayer ? get().pausedMusic : undefined;
    if (parked) {
      set({ pausedMusic: { ...parked, speed } });
      suspended?.engine?.speed(speed);
      return;
    }
    if (get().current?.track.voice) {
      const preferences = { ...get().preferences, voiceSpeed: speed };
      set({ preferences });
      deps.savePreferences(preferences);
    }
    set({ speed });
    activeSession?.engine?.speed(speed);
  }

  function stopPlayer() {
    if (!suspended) {
      stop();
      return;
    }
    music = undefined;
    resumeMusic = false;
    releaseSuspended();
    persist();
  }

  function focus() {
    const blocked = locked || call || recording.size > 0;
    if (blocked === get().blocked) {
      controls();
      return;
    }
    const active = get().current;
    set({ blocked });
    if (blocked) {
      handoff?.abort();
      cancelVoice();
      resumeMusic = false;
      // Remove the native media session as well, so remote Play cannot bypass a call.
      detach();
      releaseSuspended();
      if (active)
        set({ current: { ...active, phase: "paused", metadata: undefined } });
      persist();
    }
  }

  return {
    store,
    play,
    next,
    previous,
    seek,
    stop,
    cancelVoice,
    invalidate,
    persist,
    toggle,
    player: {
      toggle() {
        if (suspended) restoreMusic(true);
        else toggle();
      },
      stop: stopPlayer,
      seek: (position: number) => seek(position, true),
      speed: (value: Speed) => speed(value, true),
      next() {
        if (!suspended || restoreMusic(false)) return next();
      },
      previous() {
        if (!suspended || restoreMusic(false)) return previous();
      },
    },
    external(track: Track, open: (signal: AbortSignal) => Promise<void>) {
      if (get().blocked || !eligible(track)) return Promise.resolve();
      handoff?.abort();
      cancelVoice();
      const token = new AbortController();
      handoff = token;
      const active = get().current;
      if (active?.phase === "loading") {
        detach();
        set({ current: { ...active, phase: "paused" } });
        persist();
      } else activeSession?.engine?.pause();
      const task = open(token.signal)
        .catch((error: unknown) => {
          if (!token.signal.aborted) throw error;
        })
        .finally(() => {
          if (handoff === token) handoff = undefined;
        });
      return trackWork(task);
    },
    enqueue(input: Track, next = false) {
      const track = trackSchema.parse(input);
      if (!eligible(track) || get().blocked) return false;
      const id = trackId(track);
      const { current, pausedMusic, upcoming } = get();
      if (
        (current && trackId(current.track) === id) ||
        (pausedMusic && trackId(pausedMusic.track) === id)
      )
        return false;
      if (upcoming.some((item) => trackId(item) === id) && !next) return false;
      const rest = upcoming.filter((item) => trackId(item) !== id);
      if (rest.length >= 500) return false;
      set({
        upcoming: (next ? [track, ...rest] : [...rest, track]).slice(0, 500),
      });
      persist();
      return true;
    },
    reorder(id: string, position: number) {
      const upcoming = [...get().upcoming];
      const start = upcoming.findIndex((item) => trackId(item) === id);
      if (
        start < 0 ||
        position < 0 ||
        position >= upcoming.length ||
        start === position
      )
        return;
      const [item] = upcoming.splice(start, 1);
      upcoming.splice(position, 0, item);
      set({ upcoming, shuffle: false });
      persist();
    },
    remove(id: string) {
      const { current, pausedMusic, upcoming } = get();
      if (pausedMusic && trackId(pausedMusic.track) === id) {
        stopPlayer();
        return;
      }
      if (current && trackId(current.track) === id) {
        if (current.phase === "playing") {
          cancelVoice();
          detach();
          releaseSuspended();
          set({ current: undefined });
          persist();
          void next();
        } else stop();
      } else {
        cancelVoice(id);
        set({ upcoming: upcoming.filter((item) => trackId(item) !== id) });
        persist();
      }
    },
    clear() {
      if (!suspended) {
        music = undefined;
        resumeMusic = false;
      }
      set({ upcoming: [], repeat: "off" });
      persist();
    },
    toggleShuffle() {
      const { shuffle, upcoming } = get();
      const order = [...upcoming];
      if (!shuffle) {
        for (let index = order.length - 1; index > 0; index--) {
          const other = Math.floor(Math.random() * (index + 1));
          [order[index], order[other]] = [order[other], order[index]];
        }
      }
      set({ shuffle: !shuffle, upcoming: order });
      persist();
    },
    cycleRepeat() {
      const { repeat } = get();
      set({
        repeat: repeat === "off" ? "all" : repeat === "all" ? "one" : "off",
      });
      persist();
    },
    preferences(patch: Partial<Preferences>) {
      const preferences = { ...get().preferences, ...patch };
      set({ preferences });
      deps.savePreferences(preferences);
      if (patch.voiceSpeed && get().current?.track.voice) {
        set({ speed: patch.voiceSpeed });
        activeSession?.engine?.speed(patch.voiceSpeed);
      }
    },
    speed,
    privacy(state: { locked: boolean; enabled: boolean }) {
      locked = state.locked;
      privateMode = state.enabled;
      focus();
    },
    call(active: boolean) {
      call = active;
      focus();
    },
    recording(active: boolean, owner = defaultRecorder) {
      if (active) recording.add(owner);
      else recording.delete(owner);
      focus();
    },
    clearAttachments() {
      const { current, upcoming, history } = get();
      if (preparing?.track.kind === "attachment") cancelVoice();
      if (music?.track.kind === "attachment") {
        releaseSuspended();
        music = undefined;
      }
      set({
        upcoming: upcoming.filter((track) => track.kind !== "attachment"),
        history: history.filter((track) => track.kind !== "attachment"),
      });
      if (current?.track.kind === "attachment") stop();
      else persist();
    },
    revalidate() {
      const { current, upcoming, history } = get();
      for (const track of [
        ...upcoming,
        ...history,
        ...(current ? [current.track] : []),
        ...(music ? [music.track] : []),
        ...(preparing ? [preparing.track] : []),
      ])
        if (!eligible(track)) invalidate(track);
    },
    async close() {
      handoff?.abort();
      cancelVoice();
      detach();
      releaseSuspended();
      resumeMusic = false;
      const active = get().current;
      if (active)
        set({ current: current(active.track, active.position, "restored") });
      persist();
      await Promise.allSettled([...inFlight]);
      await Promise.allSettled([...inFlight]);
    },
  };
}
export type AudioController = ReturnType<typeof createAudioController>;
