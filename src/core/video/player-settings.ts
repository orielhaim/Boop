import type { VideoPlayer } from "expo-video";

type MutablePlayback = Pick<
  VideoPlayer,
  | "currentTime"
  | "playbackRate"
  | "loop"
  | "muted"
  | "volume"
  | "audioTrack"
  | "subtitleTrack"
  | "scrubbingModeOptions"
  | "seekTolerance"
  | "timeUpdateEventInterval"
>;

export function updateVideoPlayer(
  player: VideoPlayer,
  settings: Partial<MutablePlayback>,
) {
  Object.assign(player, settings);
}
