import type { CaptionRun, CaptionStyle } from "./types";

export function clockTime(value: string) {
  const parts = /^(?:(\d{1,5}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$/.exec(value);
  if (!parts) return undefined;
  return (
    Number(parts[1] ?? 0) * 3600 +
    Number(parts[2]) * 60 +
    Number(parts[3]) +
    Number(parts[4]) / 1000
  );
}

const entities = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["nbsp", "\u00a0"],
  ["lrm", "\u200e"],
  ["rlm", "\u200f"],
  ["quot", '"'],
  ["apos", "'"],
  ["hellip", "…"],
  ["ndash", "–"],
  ["mdash", "—"],
]);

function characterReference(name: string) {
  const named = entities.get(name);
  if (named !== undefined) return named;
  const hex = /^#x([0-9a-f]{1,6})$/i.exec(name);
  const decimal = /^#(\d{1,7})$/.exec(name);
  const value = hex ? Number.parseInt(hex[1], 16) : Number(decimal?.[1]);
  if (value >= 0x20 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff))
    return String.fromCodePoint(value);
}

const colors = new Set([
  "white",
  "lime",
  "cyan",
  "red",
  "yellow",
  "magenta",
  "blue",
  "black",
]);
export function captionColor(value: string | undefined) {
  const color = value?.toLowerCase();
  return color &&
    (colors.has(color) || /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(color))
    ? color
    : undefined;
}

type Frame = { tag: string; style?: CaptionStyle; speaker?: string };
const tags = new Set(["b", "i", "u", "c", "v", "lang", "ruby", "rt", "font"]);
const runLimit = 128;

export function tokenizeCue(
  text: string,
  start: number,
  end: number,
  classes?: ReadonlyMap<string, CaptionStyle>,
) {
  const runs: CaptionRun[] = [];
  const stack: Frame[] = [];
  let payload = "";
  let from: number | undefined;

  function flush() {
    if (!payload) return;
    const frame = stack.at(-1);
    if (runs.length < runLimit)
      runs.push({
        text: payload,
        style: frame?.style ?? classes?.get(""),
        speaker: frame?.speaker,
        from,
      });
    else runs[runs.length - 1].text += payload;
    payload = "";
  }

  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === "&") {
      const name = text.slice(index + 1, index + 11);
      const end = name.indexOf(";");
      const entity =
        end > 0 ? characterReference(name.slice(0, end)) : undefined;
      if (entity !== undefined) {
        payload += entity;
        index += end + 2;
        continue;
      }
    } else if (char === "<" && /[A-Za-z/\d]/.test(text[index + 1] ?? "")) {
      let finish = index + 1;
      let nested = false;
      while (
        finish < text.length &&
        text[finish] !== ">" &&
        text[finish] !== "\n"
      ) {
        nested ||= text[finish] === "<";
        finish++;
      }
      const complete = text[finish] === ">";
      const body = text.slice(index + 1, finish);
      const token =
        body.length <= 256 && complete && !nested
          ? /^(\/?)([a-z]+)(.*)$/i.exec(body)
          : null;
      const tag = token?.[2].toLowerCase();
      const argument = token?.[3] ?? "";
      const time = complete && !nested ? clockTime(body) : undefined;
      const previous = stack.at(-1);
      if (time !== undefined && time > (from ?? start) && time < end) {
        flush();
        from = time;
      } else if (token && token[1] && !argument && previous?.tag === tag) {
        if (tag === "rt") {
          const base = runs.at(-1);
          if (base && payload) base.ruby = payload;
          payload = "";
        } else flush();
        stack.pop();
      } else if (
        tag &&
        tags.has(tag) &&
        token?.[1] === "" &&
        stack.length < 12 &&
        (!argument || /^[\s.]/.test(argument)) &&
        (tag !== "rt" || previous?.tag === "ruby")
      ) {
        flush();
        const style = { ...(previous?.style ?? classes?.get("")) };
        let speaker = previous?.speaker;
        if (tag === "b") style.bold = true;
        if (tag === "i") style.italic = true;
        if (tag === "u") style.underline = true;
        if (tag === "v") speaker = argument.trim().slice(0, 80);
        if (tag === "c") {
          for (const name of argument.split(".")) {
            const declared = classes?.get(name);
            if (declared) Object.assign(style, declared);
            if (name.startsWith("bg_")) {
              const background = captionColor(name.slice(3));
              if (background) style.background = background;
            } else {
              const color = captionColor(name);
              if (color) style.color = color;
            }
          }
        }
        if (tag === "font") {
          const color = captionColor(
            /\bcolor\s*=\s*["']?(#[0-9a-f]+|[a-z]+)/i.exec(argument)?.[1],
          );
          if (color) style.color = color;
        }
        stack.push({ tag, style, speaker });
      } else {
        payload += text.slice(index, finish + Number(complete));
      }
      index = finish + Number(complete);
      continue;
    }
    payload += char;
    index++;
  }
  flush();
  return runs;
}
