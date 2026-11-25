import type { VideoPlayer } from "expo-video";
import type { SubtitleTimeline } from "./timeline";

const seeks = new WeakMap<VideoPlayer, () => void>();

export function notifySubtitleSeek(player: VideoPlayer) {
  seeks.get(player)?.();
}

export type SubtitleFrame = {
  cues: ReturnType<SubtitleTimeline["active"]>;
  time: number;
};

export function observeSubtitles(
  player: VideoPlayer,
  timeline: SubtitleTimeline,
  offset: number,
  render: (frame: SubtitleFrame) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: SubtitleFrame | undefined;
  let previousBoundary: number | undefined;
  let ended = false;

  function sync() {
    clearTimeout(timer);
    const time = player.currentTime - offset;
    const cues = ended ? [] : timeline.active(time);
    const next = timeline.next(time);
    if (
      next !== previousBoundary ||
      !frame ||
      cues.length !== frame.cues.length ||
      cues.some((cue, index) => cue !== frame?.cues[index])
    ) {
      frame = { time, cues };
      previousBoundary = next;
      render(frame);
    }
    const rate = player.playbackRate;
    if (
      !ended &&
      player.status === "readyToPlay" &&
      player.playing &&
      rate > 0 &&
      next !== undefined
    ) {
      const delay = ((next - time) / rate) * 1000;
      if (delay <= 2000)
        timer = setTimeout(sync, Math.max(8, Math.ceil(delay)));
    }
  }

  function seek() {
    ended = false;
    sync();
    // The native seek is dispatched asynchronously. The next timeUpdate also
    // reconciles slower seeks without changing the player's update interval.
    clearTimeout(timer);
    timer = setTimeout(sync, 16);
  }

  function finish() {
    ended = !player.loop;
    sync();
  }

  seeks.set(player, seek);
  const subscriptions = [
    player.addListener("timeUpdate", sync),
    player.addListener("playingChange", ({ isPlaying }) => {
      if (isPlaying) ended = false;
      sync();
    }),
    player.addListener("statusChange", sync),
    player.addListener("playbackRateChange", sync),
    player.addListener("playToEnd", finish),
  ];
  sync();
  return () => {
    if (seeks.get(player) === seek) seeks.delete(player);
    clearTimeout(timer);
    for (const subscription of subscriptions) subscription.remove();
  };
}
