import { visibleCueLimit, type SubtitleCue } from "./types";

function upperBound<Value>(
  values: readonly Value[],
  time: number,
  key: (value: Value) => number,
) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (key(values[mid]) <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function indexSubtitles(input: readonly SubtitleCue[]) {
  const cues = [...input].sort((a, b) => a.start - b.start);
  const boundaries = new Set<number>();
  for (const cue of cues) {
    boundaries.add(cue.start).add(cue.end);
    for (const run of cue.runs)
      if (run.from !== undefined && run.from > cue.start && run.from < cue.end)
        boundaries.add(run.from);
  }
  const times = [...boundaries].sort((a, b) => a - b);
  const base = 2 ** Math.ceil(Math.log2(Math.max(cues.length, 1)));
  const ends = new Float64Array(base * 2);
  cues.forEach((cue, index) => {
    ends[base + index] = cue.end;
  });
  for (let node = base - 1; node > 0; node--)
    ends[node] = Math.max(ends[node * 2], ends[node * 2 + 1]);

  return {
    cues,
    active(time: number) {
      const limit = upperBound(cues, time, (cue) => cue.start);
      const active: SubtitleCue[] = [];
      function visit(node: number, first: number, last: number) {
        if (
          first >= limit ||
          ends[node] <= time ||
          active.length >= visibleCueLimit
        )
          return;
        if (last - first === 1) {
          const cue = cues[first];
          if (cue) active.push(cue);
          return;
        }
        const middle = (first + last) >>> 1;
        visit(node * 2, first, middle);
        visit(node * 2 + 1, middle, last);
      }
      visit(1, 0, base);
      return active;
    },
    next(time: number) {
      return times[upperBound(times, time, (value) => value)];
    },
  };
}

export type SubtitleTimeline = ReturnType<typeof indexSubtitles>;
