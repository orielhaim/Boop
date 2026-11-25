import type { CaptionRun, CaptionStyle, CueLayout, SubtitleCue } from "./types";
import { cueLimit, cueTextLimit, subtitleRunLimit } from "./types";

const alignment: readonly CueLayout["align"][] = ["left", "center", "right"];
const ssaAlign = new Map([
  [1, 1],
  [2, 2],
  [3, 3],
  [5, 7],
  [6, 8],
  [7, 9],
  [9, 4],
  [10, 5],
  [11, 6],
]);

function assTime(value: string) {
  const match = /^(\d{1,5}):([0-5]\d):([0-5]\d)\.(\d{1,3})$/.exec(value.trim());
  return match
    ? Number(match[1]) * 3600 +
        Number(match[2]) * 60 +
        Number(match[3]) +
        Number("0." + match[4])
    : NaN;
}

function assColor(value: string | undefined) {
  const match = value && /^&h([0-9a-f]{1,8})&?$/i.exec(value);
  const number = match ? Number.parseInt(match[1], 16) : Number(value);
  if (!value || !Number.isFinite(number)) return undefined;
  return (
    "#" +
    [number & 255, (number >>> 8) & 255, (number >>> 16) & 255]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  );
}

function fields(line: string, columns: string[]) {
  const result = new Map<string, string>();
  let start = 0;
  for (let i = 0; i < columns.length; i++) {
    const end =
      i === columns.length - 1 ? line.length : line.indexOf(",", start);
    if (end < 0) return undefined;
    result.set(columns[i], line.slice(start, end).trim());
    start = end + 1;
  }
  return result;
}

type AssStyle = CaptionStyle & { alignment?: number };

function dialogue(
  text: string,
  style: AssStyle,
  start: number,
  width: number,
  height: number,
) {
  const runs: CaptionRun[] = [];
  let current: CaptionStyle = { ...style };
  let align = style.alignment;
  let x: number | undefined;
  let y: number | undefined;
  let drawing = false;
  let elapsed = start;
  let from: number | undefined;

  for (const match of text.matchAll(/\{(\\[^{}]*)\}|([^{}]+|[{}])/g)) {
    if (match[1] !== undefined) {
      for (const tag of match[1].split("\\")) {
        const flag = /^(b|i|u)(-?\d+)$/.exec(tag);
        if (flag) {
          const key =
            flag[1] === "b" ? "bold" : flag[1] === "i" ? "italic" : "underline";
          current = { ...current, [key]: Number(flag[2]) !== 0 };
        } else if (/^(?:1?c)&h/i.test(tag)) {
          current = {
            ...current,
            color: assColor(tag.slice(tag.indexOf("&"))) ?? style.color,
          };
        } else if (/^an[1-9]$/.test(tag)) {
          align = Number(tag[2]);
        } else if (/^a\d+$/.test(tag)) {
          align = ssaAlign.get(Number(tag.slice(1))) ?? align;
        } else if (/^p\d+$/.test(tag)) {
          drawing = Number(tag.slice(1)) > 0;
        } else if (/^r(?:[^\\]*)$/.test(tag)) {
          current = { ...style };
        } else {
          const point = /^pos\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)$/.exec(
            tag,
          );
          const karaoke = /^k[fo]?(\d{1,6})$/i.exec(tag);
          if (point && width && height) {
            x = Math.max(0, Math.min(100, (Number(point[1]) / width) * 100));
            y = Math.max(0, Math.min(100, (Number(point[2]) / height) * 100));
          } else if (karaoke) {
            from = elapsed;
            elapsed += Number(karaoke[1]) / 100;
          }
        }
      }
    } else if (!drawing && match[2]) {
      const value = match[2].replace(/\\([Nnh])/g, (_escape, char: string) =>
        char === "h" ? "\u00a0" : "\n",
      );
      if (runs.length < 128) runs.push({ text: value, style: current, from });
      else runs[runs.length - 1].text += value;
    }
  }
  const layout: CueLayout = { x, y, align: alignment[((align ?? 2) - 1) % 3] };
  if (layout.y === undefined && align && align >= 4)
    layout.y = align >= 7 ? 8 : 50;
  return { runs, layout };
}

export function parseAss(lines: string[], ssa: boolean) {
  let section = "";
  let columns: string[] = [];
  let width = 0;
  let height = 0;
  const styles = new Map<string, AssStyle>();
  const cues: SubtitleCue[] = [];
  let runCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      section = trimmed.toLowerCase();
      columns = [];
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const payload = line.slice(colon + 1);
    if (section === "[script info]") {
      if (key === "playresx") width = Math.max(0, Number(payload));
      if (key === "playresy") height = Math.max(0, Number(payload));
      continue;
    }
    if (
      section !== "[events]" &&
      section !== "[v4+ styles]" &&
      section !== "[v4 styles]"
    )
      continue;
    if (key === "format") {
      columns =
        payload.length <= 512
          ? payload
              .toLowerCase()
              .split(",")
              .map((field) => field.trim())
          : [];
      continue;
    }
    if (
      !columns.length ||
      columns.length > 32 ||
      payload.length > cueTextLimit + 512
    )
      continue;
    const entry = fields(payload, columns);
    if (!entry) continue;
    if (key === "style" && section !== "[events]" && styles.size < 256) {
      const name = entry.get("name");
      const align = Number(entry.get("alignment"));
      if (name)
        styles.set(name.toLowerCase(), {
          bold: Number(entry.get("bold") ?? 0) !== 0,
          italic: Number(entry.get("italic") ?? 0) !== 0,
          underline: Number(entry.get("underline") ?? 0) !== 0,
          color: assColor(entry.get("primarycolour")),
          background:
            Number(entry.get("borderstyle")) === 3
              ? assColor(entry.get("backcolour"))
              : undefined,
          alignment: ssa
            ? ssaAlign.get(align)
            : align >= 1 && align <= 9
              ? align
              : undefined,
        });
    } else if (
      key === "dialogue" &&
      section === "[events]" &&
      columns.at(-1) === "text"
    ) {
      const start = assTime(entry.get("start") ?? "");
      const end = assTime(entry.get("end") ?? "");
      const text = entry.get("text");
      if (
        !text ||
        text.length > cueTextLimit ||
        !Number.isFinite(start) ||
        end <= start ||
        !Number.isFinite(end)
      )
        continue;
      const style =
        styles.get(entry.get("style")?.toLowerCase() ?? "default") ?? {};
      const { runs, layout } = dialogue(text, style, start, width, height);
      if (runCount + runs.length > subtitleRunLimit) break;
      if (runs.length) {
        runCount += runs.length;
        cues.push({ start, end, runs, layout });
      }
      if (cues.length === cueLimit) break;
    }
  }
  return cues;
}
