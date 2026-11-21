import { validateVideo, validateVoiceAudio } from "./audio-format";
import { byteLimit, type AttachmentMetadata } from "./protocol";

export function validateAttachment(
  bytes: Uint8Array,
  file: AttachmentMetadata,
) {
  if (!bytes.length || bytes.length > byteLimit(file.kind) - 16)
    throw new Error("media-size");
  if (file.kind === "voice") return validateVoiceAudio(bytes);
  if (file.kind === "video" || file.kind === "round-video")
    return validateVideo(bytes);
  if (file.kind !== "image") {
    if (
      file.mime === "application/pdf" &&
      !new TextDecoder().decode(bytes.subarray(0, 5)).startsWith("%PDF-")
    )
      throw new Error("media-format");
    if (
      (file.mime === "application/zip" ||
        file.mime.startsWith(
          "application/vnd.openxmlformats-officedocument.",
        )) &&
      (bytes[0] !== 80 ||
        bytes[1] !== 75 ||
        !([3, 5, 7].includes(bytes[2]) && bytes[3] === bytes[2] + 1))
    )
      throw new Error("media-format");
    return;
  }
  const text = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  const ends = (a: number, b: number) =>
    bytes[bytes.length - 2] === a && bytes[bytes.length - 1] === b;
  const ok =
    bytes.length >= 16 &&
    ((file.mime === "image/jpeg" &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      ends(255, 217)) ||
      (file.mime === "image/png" &&
        bytes[0] === 137 &&
        text(1, 8) === "PNG\r\n\x1a\n" &&
        text(12, 16) === "IHDR" &&
        text(bytes.length - 8, bytes.length - 4) === "IEND") ||
      (file.mime === "image/webp" &&
        text(0, 4) === "RIFF" &&
        text(8, 12) === "WEBP" &&
        new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ).getUint32(4, true) ===
          bytes.length - 8) ||
      (file.mime === "image/gif" &&
        ["GIF87a", "GIF89a"].includes(text(0, 6)) &&
        bytes[bytes.length - 1] === 59));
  if (!ok) throw new Error("media-format");
  const [width, height] = imageDimensions(bytes, file.mime);
  if (
    !width ||
    !height ||
    width > 8192 ||
    height > 8192 ||
    width * height > 32_000_000
  )
    throw new Error("media-format");
}

function imageDimensions(bytes: Uint8Array, mime: string): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png" && bytes.length >= 33)
    return [view.getUint32(16), view.getUint32(20)];
  if (mime === "image/gif")
    return [view.getUint16(6, true), view.getUint16(8, true)];
  if (mime === "image/webp" && bytes.length >= 30) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X") {
      const dimension = (i: number) =>
        1 + bytes[i] + 256 * bytes[i + 1] + 65536 * bytes[i + 2];
      return [dimension(24), dimension(27)];
    }
    if (chunk === "VP8L" && bytes[20] === 47) {
      const bits = view.getUint32(21, true);
      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    }
    if (
      chunk === "VP8 " &&
      bytes[23] === 157 &&
      bytes[24] === 1 &&
      bytes[25] === 42
    )
      return [
        view.getUint16(26, true) & 0x3fff,
        view.getUint16(28, true) & 0x3fff,
      ];
  }
  if (mime === "image/jpeg") {
    for (let i = 2; i + 8 < bytes.length && bytes[i] === 255;) {
      const marker = bytes[i + 1];
      if (marker === 255) {
        i++;
        continue;
      }
      const length = view.getUint16(i + 2);
      if (length < 2 || i + 2 + length > bytes.length || marker === 218) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      )
        return [view.getUint16(i + 7), view.getUint16(i + 5)];
      i += 2 + length;
    }
  }
  return [0, 0];
}
