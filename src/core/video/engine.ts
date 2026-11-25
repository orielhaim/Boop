import { createVideoPlayer } from "expo-video";
import type { MediaHandle } from "@/core/media/source";

export function createVideoEngine() {
  const player = createVideoPlayer(null);
  player.audioMixingMode = "doNotMix";
  player.preservesPitch = true;
  player.keepScreenOnWhilePlaying = false;
  player.timeUpdateEventInterval = 0.25;
  let loading: Promise<void> | undefined;

  return {
    player,
    async load(handle: MediaHandle, title: string) {
      if (handle.expiresAt !== null) {
        if (
          !("setPlaybackDeadline" in player) ||
          typeof player.setPlaybackDeadline !== "function"
        ) {
          throw new Error("VideoDeadlineUnavailable");
        }
        player.setPlaybackDeadline(handle.expiresAt);
      }
      const candidateMimeType =
        handle.kind === "progressive" ? handle.mimeType.trim() : "";
      const normalizedMimeType = candidateMimeType.toLowerCase();
      const mimeType =
        normalizedMimeType &&
        normalizedMimeType !== "application/octet-stream" &&
        !normalizedMimeType.endsWith("/*")
          ? candidateMimeType
          : undefined;
      loading = player.replaceAsync({
        uri: handle.uri,
        ...(handle.kind === "progressive"
          ? { contentType: "progressive", mimeType }
          : {}),
        useCaching: false,
        metadata: { title },
      });
      await loading;
    },
    async close() {
      try {
        await loading?.catch(() => undefined);
        await player.replaceAsync(null);
      } finally {
        player.release();
      }
    },
    stop() {
      player.pause();
      player.showNowPlayingNotification = false;
      player.staysActiveInBackground = false;
      player.keepScreenOnWhilePlaying = false;
    },
  };
}
