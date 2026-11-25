import { parseAss } from "./ass";
import { decodeSubtitle, type SubtitleEncoding } from "./encoding";
import { captionColor, clockTime, tokenizeCue } from "./tokenize";
import {
  cueLimit,
  cueTextLimit,
  subtitleByteLimit,
  subtitleRunLimit,
  type CaptionStyle,
  type CueLayout,
  type SubtitleCue,
  type SubtitleFormat,
} from "./types";

const supportedFormats = ["srt", "vtt", "ass", "ssa"] as const;

export function subtitleFormat(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  return supportedFormats.find((format) => extension === format);
}

function percent(value: string) {
  return /^\d{1,3}(?:\.\d+)?%$/.test(value)
    ? Math.min(100, Number(value.slice(0, -1)))
    : undefined;
}

function cueStyles(block: string, styles: Map<string, CaptionStyle>) {
  if (block.length > 4096) return;
  for (const match of block.matchAll(
    /::cue(?:\(\.([a-z0-9_-]{1,32})\))?\s*\{([^{}]*)\}/gi,
  )) {
    const key = match[1] ?? "";
    if (styles.size >= 64 && !styles.has(key)) break;
    const style = { ...styles.get(key) };
    for (const declaration of match[2].split(";")) {
      const [property, value] = declaration
        .split(":", 2)
        .map((part) => part.trim().toLowerCase());
      const color = captionColor(value);
      if (color && property === "color") style.color = color;
      if (color && property === "background-color") style.background = color;
      if (
        property === "font-weight" &&
        (value === "bold" || value === "normal")
      )
        style.bold = value === "bold";
      if (
        property === "font-style" &&
        (value === "italic" || value === "normal")
      )
        style.italic = value === "italic";
      if (
        property === "text-decoration" &&
        (value === "underline" || value === "none")
      )
        style.underline = value === "underline";
    }
    if (Object.keys(style).length) styles.set(key, style);
  }
}

function cueSettings(
  settings: string,
  regions: Map<string, CueLayout>,
): CueLayout | undefined {
  const layout: CueLayout = {};
  let hasLayout = false;
  for (const setting of settings.trim().split(/\s+/)) {
    const [key, val] = setting.split(":", 2);
    if (!val) continue;
    const value = val.split(",", 1)[0];
    if (key === "region") {
      const region = regions.get(value);
      if (region) {
        Object.assign(layout, region, { ...layout });
        hasLayout = true;
      }
    } else if (
      key === "align" &&
      (value === "start" ||
        value === "end" ||
        value === "left" ||
        value === "right" ||
        value === "center")
    ) {
      layout.align = value;
      hasLayout = true;
    } else {
      const index =
        key === "position"
          ? "x"
          : key === "line"
            ? "y"
            : key === "size"
              ? "width"
              : undefined;
      const amount = percent(value);
      if (index && amount !== undefined) {
        layout[index] = amount;
        hasLayout = true;
      }
    }
  }
  return hasLayout ? layout : undefined;
}

function parseTimedBlocks(text: string, format: "vtt" | "srt") {
  const cues: SubtitleCue[] = [];
  let runCount = 0;
  const regions = new Map<string, CueLayout>();
  const classes = new Map<string, CaptionStyle>();
  for (const block of text.split(/\n[ \t]*\n/)) {
    const lines = block.trim().split("\n");
    const first = lines[0];
    if (format === "vtt") {
      if (/^(?:WEBVTT|NOTE)(?:\s|$)/.test(first)) continue;
      if (first === "STYLE") {
        if (!cues.length) cueStyles(block, classes);
        continue;
      }
      if (first === "REGION") {
        if (regions.size >= 64 || block.length > 512) continue;
        const props = new Map(
          lines.slice(1).map((line) => {
            const [key, value = ""] = line.trim().split(":", 2);
            return [key, value.trim()] as const;
          }),
        );
        const id = props.get("id");
        const [x = "", y = ""] = (props.get("viewportanchor") ?? "").split(
          ",",
          2,
        );
        if (id)
          regions.set(id, {
            x: percent(x),
            y: percent(y),
            width: percent(props.get("width") ?? ""),
          });
        continue;
      }
    }
    const index = first.includes("-->") ? 0 : 1;
    const range = /^\s*(\S+)\s*-->\s*(\S+)(.*)$/.exec(lines[index] ?? "");
    if (!range) continue;
    const start = clockTime(range[1]);
    const end = clockTime(range[2]);
    const payload = lines
      .slice(index + 1)
      .join("\n")
      .trim();
    if (
      start === undefined ||
      end === undefined ||
      end <= start ||
      !payload ||
      payload.length > cueTextLimit
    )
      continue;
    const runs = tokenizeCue(payload, start, end, classes);
    if (runCount + runs.length > subtitleRunLimit) break;
    if (runs.length) {
      runCount += runs.length;
      cues.push({
        start,
        end,
        runs,
        layout: format === "vtt" ? cueSettings(range[3], regions) : undefined,
      });
    }
    if (cues.length === cueLimit) break;
  }
  return cues;
}

export function parseSubtitle(
  bytes: Uint8Array,
  name: string,
  encoding: SubtitleEncoding = "auto",
) {
  if (!bytes.length || bytes.length > subtitleByteLimit) return undefined;
  const text = decodeSubtitle(bytes, encoding)
    .replace(/\r\n?/g, "\n")
    .replace(/\0/g, "\ufffd");
  let format: SubtitleFormat | undefined = subtitleFormat(name);
  if (/^\s*WEBVTT(?:[ \t\n]|$)/.test(text)) format = "vtt";
  else if (/^\s*\[Script Info\]/i.test(text))
    format = /^\[V4 Styles\]/im.test(text) ? "ssa" : "ass";
  if (!format) return undefined;
  const cues =
    format === "ass" || format === "ssa"
      ? parseAss(text.split("\n"), format === "ssa")
      : parseTimedBlocks(text, format);
  return cues.length ? { format, cues } : undefined;
}
