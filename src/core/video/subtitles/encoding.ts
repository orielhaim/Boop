import { legacyEncodings, legacyTables } from "./encoding-tables";

export const subtitleEncodings = [
  "auto",
  "utf-8",
  "utf-16le",
  "utf-16be",
  ...legacyEncodings,
] as const;
export type SubtitleEncoding = (typeof subtitleEncodings)[number];

function utf16(bytes: Uint8Array, littleEndian: boolean) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: string[] = [];
  for (let index = 0; index + 1 < bytes.length;) {
    const end = Math.min(index + 4096, bytes.length - (bytes.length % 2));
    const chunk: number[] = [];
    for (; index < end; index += 2)
      chunk.push(view.getUint16(index, littleEndian));
    parts.push(String.fromCharCode(...chunk));
  }
  return parts.join("");
}

export function decodeSubtitle(bytes: Uint8Array, encoding: SubtitleEncoding) {
  if (encoding === "utf-16le" || encoding === "utf-16be")
    return utf16(bytes, encoding === "utf-16le").replace(/^\ufeff/, "");
  if (encoding === "utf-8")
    return new TextDecoder().decode(bytes).replace(/^\ufeff/, "");
  if (encoding === "auto") {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return utf16(bytes.subarray(2), true);
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
      return utf16(bytes.subarray(2), false);
    const sample = Math.min(bytes.length, 256);
    let even = 0;
    let odd = 0;
    for (let index = 0; index + 1 < sample; index += 2) {
      if (bytes[index] === 0) even++;
      if (bytes[index + 1] === 0) odd++;
    }
    if (odd > sample / 6 && even === 0) return utf16(bytes, true);
    if (even > sample / 6 && odd === 0) return utf16(bytes, false);
    const text = new TextDecoder().decode(bytes).replace(/^\ufeff/, "");
    if (
      !text.includes("\ufffd") ||
      (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    )
      return text;
    // The legacy code pages overlap. Default to Western European; the picker
    // lets the user choose the intended Hebrew, Cyrillic, or Arabic encoding.
    return decodeSubtitle(bytes, "windows-1252");
  }
  const table = legacyTables[encoding];
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 4096) {
    let chunk = "";
    for (const byte of bytes.subarray(index, index + 4096))
      chunk += byte < 0x80 ? String.fromCharCode(byte) : table[byte - 0x80];
    parts.push(chunk);
  }
  return parts.join("");
}
