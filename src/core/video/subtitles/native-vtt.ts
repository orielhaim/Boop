import type { ExternalSubtitle } from "./tracks";
import { subtitleByteLimit, type CaptionRun } from "./types";

function timestamp(seconds: number) {
  const ms = Math.round(seconds * 1000);
  return (
    [
      String(Math.floor(ms / 3600000)).padStart(2, "0"),
      String(Math.floor(ms / 60000) % 60).padStart(2, "0"),
      String(Math.floor(ms / 1000) % 60).padStart(2, "0"),
    ].join(":") +
    "." +
    String(ms % 1000).padStart(3, "0")
  );
}

const escaped = new Map([
  ["<", "&lt;"],
  [">", "&gt;"],
  ["&", "&amp;"],
]);

function formatRun(run: CaptionRun) {
  let text = run.text.replace(/[<>&]/g, (char) => escaped.get(char) ?? char);
  if (run.style?.bold) text = "<b>" + text + "</b>";
  if (run.style?.italic) text = "<i>" + text + "</i>";
  if (run.style?.underline) text = "<u>" + text + "</u>";
  return text;
}

export function nativeSubtitle(track: ExternalSubtitle, offset: number) {
  // These features need Boop's structured overlay to preserve their meaning.
  const blocks = ["WEBVTT"];
  let length = 8;
  for (const cue of track.timeline.cues) {
    if (
      cue.runs.some(
        (run) =>
          run.ruby ||
          run.speaker ||
          run.from !== undefined ||
          run.style?.color ||
          run.style?.background,
      )
    )
      return undefined;
    const start = Math.max(0, cue.start + offset);
    const end = cue.end + offset;
    if (end <= start) continue;
    let settings = "";
    const layout = cue.layout;
    if (layout?.x !== undefined) settings += " position:" + layout.x + "%";
    if (layout?.y !== undefined) settings += " line:" + layout.y + "%";
    if (layout?.width !== undefined) settings += " size:" + layout.width + "%";
    if (layout?.align !== undefined) settings += " align:" + layout.align;
    const text = cue.runs.map(formatRun).join("");
    if (!text.trim()) continue;
    const block =
      timestamp(start) + " --> " + timestamp(end) + settings + "\n" + text;
    length += block.length + 2;
    if (length > subtitleByteLimit) return undefined;
    blocks.push(block);
  }
  if (blocks.length === 1) return undefined;
  const vtt = blocks.join("\n\n") + "\n";
  return new TextEncoder().encode(vtt).length <= subtitleByteLimit
    ? vtt
    : undefined;
}
