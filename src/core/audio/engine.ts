import {
  type AudioPlaylist,
  createAudioPlaylist,
  setAudioModeAsync,
} from "expo-audio";
import type { AudioEngine, Commands } from "./controller";

export function setupPlayback() {
  return setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: "doNotMix",
    shouldRouteThroughEarpiece: false,
  });
}

export function createNativePlayback() {
  type Slot = {
    player: AudioPlaylist;
    mode?: "voice" | "audio";
    metadata?: string;
  };
  let idle: Slot | undefined;

  function deadline(player: AudioPlaylist, expiresAt: number | null) {
    if (
      "setPlaybackDeadline" in player &&
      typeof player.setPlaybackDeadline === "function"
    )
      player.setPlaybackDeadline(expiresAt);
  }

  function clearControls(slot: Slot) {
    if (slot.mode) slot.player.clearLockScreenControls();
    slot.mode = undefined;
    slot.metadata = undefined;
    deadline(slot.player, null);
  }

  function destroy(slot: Slot) {
    const { player } = slot;
    player.pause();
    clearControls(slot);
    player.destroy();
    player.release();
  }

  function dispose() {
    const slot = idle;
    idle = undefined;
    if (slot) destroy(slot);
  }

  function open(
    uri: string,
    commands: Commands,
    expiresAt: number | null,
    isolated = false,
  ): AudioEngine {
    const existing = isolated ? undefined : idle;
    if (existing) idle = undefined;
    const slot: Slot = existing ?? {
      player: createAudioPlaylist({ sources: [{ uri }], updateInterval: 250 }),
    };
    const { player } = slot;
    let closed = false;
    let loaded = false;
    let loadError: Error | undefined;
    let finishWaiting: ((error?: unknown) => void) | undefined;
    function failed() {
      loadError = new Error("AudioUnavailable");
      clearTimeout(loadTimeout);
      finishWaiting?.(loadError);
    }
    const loadTimeout = setTimeout(() => {
      if (!loaded && !closed) {
        failed();
        commands.status({
          position: 0,
          duration: 0,
          playing: false,
          failed: true,
        });
      }
    }, 15_000);
    const subscription = player.addListener(
      "playlistStatusUpdate",
      (status) => {
        if (closed) return;
        if ("remoteCommand" in status) {
          switch (status.remoteCommand) {
            case "next":
              commands.next();
              break;
            case "previous":
              commands.previous();
              break;
            case "stop":
              commands.stop();
              break;
          }
          return;
        }
        if ("error" in status) failed();
        else if (status.trackCount === 0) return;
        if (status.isLoaded) {
          loaded = true;
          clearTimeout(loadTimeout);
          finishWaiting?.();
        }
        if (!loaded && !("error" in status)) return;
        commands.status({
          position: Number.isFinite(status.currentTime)
            ? Math.max(0, status.currentTime)
            : 0,
          duration: Number.isFinite(status.duration)
            ? Math.max(0, status.duration)
            : 0,
          playing: status.playing,
          ended: status.didJustFinish,
          failed: "error" in status,
        });
      },
    );
    if (existing) player.add({ uri });
    return {
      async ready(signal) {
        signal.throwIfAborted();
        if (loadError || closed)
          throw loadError ?? new Error("AudioUnavailable");
        if (loaded || player.currentStatus.isLoaded) {
          loaded = true;
          clearTimeout(loadTimeout);
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const cancel = () => finish(signal.reason);
          const finish = (error?: unknown) => {
            signal.removeEventListener("abort", cancel);
            finishWaiting = undefined;
            if (error) reject(error);
            else resolve();
          };
          finishWaiting = finish;
          signal.addEventListener("abort", cancel, { once: true });
        });
      },
      snapshot() {
        const { currentTime, playing } = player.currentStatus;
        return { position: currentTime, playing };
      },
      play: () => player.play(),
      pause: () => player.pause(),
      seek: (position) => player.seekTo(position),
      speed(speed) {
        player.playbackRate = speed;
      },
      controls(metadata, voice) {
        const mode = voice ? "voice" : "audio";
        const media = metadata ? { ...metadata, artworkUrl: undefined } : null;
        const key = JSON.stringify(media);
        if (!media) {
          clearControls(slot);
          return;
        }
        deadline(player, expiresAt);
        if (slot.mode !== mode) {
          player.setActiveForLockScreen(true, media, {
            showNextTrack: !voice,
            showPreviousTrack: !voice,
            showSeekForward: voice,
            showSeekBackward: voice,
          });
          slot.mode = mode;
        } else if (slot.metadata !== key) {
          player.updateLockScreenMetadata(media);
        }
        slot.metadata = key;
      },
      close(keepSession) {
        if (closed) return;
        closed = true;
        clearTimeout(loadTimeout);
        subscription.remove();
        finishWaiting?.(new Error("AudioUnavailable"));
        if (keepSession) {
          player.pause();
          deadline(player, null);
          player.clear();
          dispose();
          idle = slot;
        } else destroy(slot);
      },
    };
  }

  return { open, dispose };
}
