import { formatInput, type MediaFormatInput } from "./format-input";

// Check the ISO BMFF box boundaries and require a standalone audio track.
function boxes(file: MediaFormatInput, start: number, end: number) {
  const result: { type: string; start: number; end: number }[] = [];
  while (start < end) {
    if (end - start < 8 || result.length >= 512)
      throw new Error("media-format");
    const prefix = file.read(start, 8);
    let length = new DataView(prefix.buffer, prefix.byteOffset, 8).getUint32(0);
    let header = 8;
    if (length === 1) {
      if (end - start < 16) throw new Error("media-format");
      const extended = file.read(start + 8, 8);
      const view = new DataView(extended.buffer, extended.byteOffset, 8);
      if (view.getUint32(0) !== 0) throw new Error("media-format");
      length = view.getUint32(4);
      header = 16;
    } else if (length === 0) {
      length = end - start;
    }
    const type = String.fromCharCode(...file.read(start + 4, 4));
    if (length < header || length > end - start)
      throw new Error("media-format");
    result.push({ type, start: start + header, end: start + length });
    start += length;
  }
  return result;
}

function movieTracks(file: MediaFormatInput) {
  const top = boxes(file, 0, file.size);
  const movie = top.find(({ type }) => type === "moov");
  const data = top.find(
    ({ type, start, end }) => type === "mdat" && end > start,
  );
  if (top[0]?.type !== "ftyp" || !movie || !data)
    throw new Error("media-format");
  const children = (box: { start: number; end: number }) =>
    boxes(file, box.start, box.end);
  const tracks = children(movie).filter(({ type }) => type === "trak");
  if (
    children(movie).some(({ type }) => type === "rmra") ||
    top.some(({ type }) => type === "rmra")
  )
    throw new Error("media-format");
  return { tracks, children };
}
export function validateVoiceAudio(input: Uint8Array | MediaFormatInput) {
  const file = formatInput(input);
  const { tracks, children } = movieTracks(file);
  if (tracks.length !== 1) throw new Error("media-format");
  const media = children(tracks[0]).find(({ type }) => type === "mdia");
  const handler = media && children(media).find(({ type }) => type === "hdlr");
  if (
    !handler ||
    handler.end - handler.start < 12 ||
    String.fromCharCode(...file.read(handler.start + 8, 4)) !== "soun"
  )
    throw new Error("media-format");
  const info = media && children(media).find(({ type }) => type === "minf");
  const table = info && children(info).find(({ type }) => type === "stbl");
  const descriptions =
    table && children(table).find(({ type }) => type === "stsd");
  if (!descriptions || descriptions.end - descriptions.start < 16)
    throw new Error("media-format");
  const codecs = boxes(file, descriptions.start + 8, descriptions.end);
  if (codecs.length !== 1 || codecs[0].type !== "mp4a")
    throw new Error("media-format");
}

export function validateVideo(input: Uint8Array | MediaFormatInput) {
  const file = formatInput(input);
  const { tracks, children } = movieTracks(file);
  let hasVideo = false;
  for (const track of tracks) {
    const media = children(track).find(({ type }) => type === "mdia");
    if (!media) throw new Error("media-format");
    const handler = children(media).find(({ type }) => type === "hdlr");
    const info = children(media).find(({ type }) => type === "minf");
    const references =
      info && children(info).find(({ type }) => type === "dinf");
    const table =
      references && children(references).find(({ type }) => type === "dref");
    if (
      handler &&
      handler.end - handler.start >= 12 &&
      String.fromCharCode(...file.read(handler.start + 8, 4)) === "vide"
    )
      hasVideo = true;
    if (table) {
      if (table.end - table.start < 8) throw new Error("media-format");
      for (const entry of boxes(file, table.start + 8, table.end)) {
        if (
          entry.type !== "url " ||
          entry.end - entry.start !== 4 ||
          file
            .read(entry.start, 4)
            .some((byte, i) => byte !== (i === 3 ? 1 : 0))
        )
          throw new Error("media-format");
      }
    }
  }
  if (!hasVideo) throw new Error("media-format");
}
