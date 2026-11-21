// Check the ISO BMFF box boundaries and require a standalone audio track.
function boxes(bytes: Uint8Array, start: number, end: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: { type: string; start: number; end: number }[] = [];
  while (start < end) {
    if (end - start < 8 || result.length >= 512)
      throw new Error("media-format");
    let length = view.getUint32(start);
    let header = 8;
    if (length === 1) {
      if (end - start < 16 || view.getUint32(start + 8) !== 0)
        throw new Error("media-format");
      length = view.getUint32(start + 12);
      header = 16;
    } else if (length === 0) {
      length = end - start;
    }
    const type = String.fromCharCode(...bytes.subarray(start + 4, start + 8));
    if (length < header || length > end - start)
      throw new Error("media-format");
    result.push({ type, start: start + header, end: start + length });
    start += length;
  }
  return result;
}

export function validateVoiceAudio(bytes: Uint8Array) {
  const top = boxes(bytes, 0, bytes.length);
  const movie = top.find(({ type }) => type === "moov");
  const data = top.find(
    ({ type, start, end }) => type === "mdat" && end > start,
  );
  if (top[0]?.type !== "ftyp" || !movie || !data)
    throw new Error("media-format");
  const children = (box: { start: number; end: number }) =>
    boxes(bytes, box.start, box.end);
  const tracks = children(movie).filter(({ type }) => type === "trak");
  if (tracks.length !== 1) throw new Error("media-format");
  const media = children(tracks[0]).find(({ type }) => type === "mdia");
  const handler = media && children(media).find(({ type }) => type === "hdlr");
  if (
    !handler ||
    handler.end - handler.start < 12 ||
    String.fromCharCode(
      ...bytes.subarray(handler.start + 8, handler.start + 12),
    ) !== "soun"
  )
    throw new Error("media-format");
  const info = media && children(media).find(({ type }) => type === "minf");
  const table = info && children(info).find(({ type }) => type === "stbl");
  const descriptions =
    table && children(table).find(({ type }) => type === "stsd");
  if (!descriptions || descriptions.end - descriptions.start < 16)
    throw new Error("media-format");
  const codecs = boxes(bytes, descriptions.start + 8, descriptions.end);
  if (codecs.length !== 1 || codecs[0].type !== "mp4a")
    throw new Error("media-format");
}
