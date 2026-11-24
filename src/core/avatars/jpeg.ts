export const maxAvatarBytes = 250 * 1024;

// JFIF 1.01 with unitless 1:1 density and no thumbnail.
const jfif = Uint8Array.of(
  0xff,
  0xe0,
  0,
  16,
  0x4a,
  0x46,
  0x49,
  0x46,
  0,
  1,
  1,
  0,
  0,
  1,
  0,
  1,
  0,
  0,
);

export function sanitizeAvatarJpeg(bytes: Uint8Array, wide = false) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.length > maxAvatarBytes)
    throw new Error("Invalid JPEG");
  const result = new Uint8Array(bytes.length + jfif.length);
  result.set(bytes.subarray(0, 2));
  result.set(jfif, 2);
  let written = 2 + jfif.length;
  let cursor = 2;
  let dimension = 0;
  let imageHeight = 0;
  let scanned = false;
  while (cursor < bytes.length) {
    const start = cursor;
    if (bytes[cursor++] !== 0xff) break;
    while (bytes[cursor] === 0xff) cursor++;
    const marker = bytes[cursor++];
    if (marker === 0xd9 && scanned && dimension) {
      if (written + 2 > maxAvatarBytes) throw new Error("Invalid JPEG");
      result.set([0xff, 0xd9], written);
      return {
        bytes: result.slice(0, written + 2),
        dimension,
        height: imageHeight,
      };
    }
    if (
      marker === undefined ||
      marker < 0xc0 ||
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      cursor + 2 > bytes.length
    )
      break;
    const length = (bytes[cursor] << 8) + bytes[cursor + 1];
    const end = cursor + length;
    if (length < 2 || end > bytes.length) break;
    if (marker === 0xc0 || marker === 0xc2) {
      if (dimension || length < 8 || bytes[cursor + 2] !== 8) break;
      const height = (bytes[cursor + 3] << 8) + bytes[cursor + 4];
      const width = (bytes[cursor + 5] << 8) + bytes[cursor + 6];
      if (
        height < 1 ||
        width < 1 ||
        (wide
          ? width > 1024 || height > 512 || height >= width
          : width !== height || width > 512)
      )
        break;
      imageHeight = height;
      dimension = width;
    }
    cursor = end;
    if (marker === 0xda) {
      scanned = true;
      while (cursor + 1 < bytes.length) {
        if (bytes[cursor] !== 0xff) {
          cursor++;
          continue;
        }
        const next = bytes[cursor + 1];
        if (next !== 0 && (next < 0xd0 || next > 0xd7)) break;
        cursor += 2;
      }
    }
    if ((marker < 0xe0 || marker > 0xef) && marker !== 0xfe) {
      result.set(bytes.subarray(start, cursor), written);
      written += cursor - start;
    }
  }
  throw new Error("Invalid JPEG");
}
