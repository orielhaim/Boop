export const subtitleByteLimit = 2 * 1024 * 1024;

export type SubtitleCue = {
  start: number;
  end: number;
  text: string;
};

export type LocalCaptions = {
  name: string;
  cues: SubtitleCue[];
  offset: number;
  large: boolean;
};

function decode(bytes: Uint8Array) {
  const littleEndian = bytes[0] === 0xff && bytes[1] === 0xfe;
  const bigEndian = bytes[0] === 0xfe && bytes[1] === 0xff;
  if (littleEndian || bigEndian) {
    let result = "";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      result += String.fromCharCode(view.getUint16(index, littleEndian));
    }
    return result;
  }
  const utf8 = new TextDecoder().decode(bytes);
  if (!utf8.includes("\ufffd")) return utf8;
  // Older Hebrew SRT files commonly use Windows-1255.
  return Array.from(bytes, (byte) =>
    String.fromCharCode(
      byte >= 0xe0 && byte <= 0xfa ? 0x05d0 + byte - 0xe0 : byte,
    ),
  ).join("");
}

function timestamp(value: string) {
  const parts = /^(?:(\d{1,5}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$/.exec(value);
  if (!parts) return;
  const [, hours, minutes, seconds, milliseconds] = parts;
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(milliseconds) / 1000
  );
}

export function readSubtitles(bytes: Uint8Array) {
  if (bytes.length > subtitleByteLimit) return [];
  const blocks = decode(bytes)
    .replace(/^\ufeff/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(block)) continue;
    const lines = block.trim().split("\n");
    const index = lines[0]?.includes("-->") ? 0 : 1;
    const range = /^\s*(\S+)\s*-->\s*(\S+)/.exec(lines[index] ?? "");
    if (!range) continue;
    const start = timestamp(range[1]);
    const end = timestamp(range[2]);
    const text = lines
      .slice(index + 1)
      .join("\n")
      .replace(/<[^>\n]*>/g, "")
      .replace(/&(?:lt|gt|amp|nbsp);/g, (entity) => {
        if (entity === "&lt;") return "<";
        if (entity === "&gt;") return ">";
        if (entity === "&nbsp;") return " ";
        return "&";
      })
      .trim();
    if (
      start === undefined ||
      end === undefined ||
      end <= start ||
      !text ||
      text.length > 2048
    )
      continue;
    cues.push({ start, end, text });
    if (cues.length === 10_000) break;
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function subtitleAt(cues: SubtitleCue[], position: number) {
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (cues[middle].start <= position) low = middle + 1;
    else high = middle;
  }
  const cue = cues[low - 1];
  return cue && position < cue.end ? cue.text : undefined;
}
