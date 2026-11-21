import { z } from "zod";
import { publicMediaUrl } from "./url";

export const fileMessageKind = 15;
export const voiceMime = "audio/mp4";
export const maxVoiceDuration = 300_000;
export const minVoiceDuration = 450;
export const maxVoiceBytes = 8 * 1024 * 1024;
export const maxAttachmentBytes = 32 * 1024 * 1024;
export const attachmentKind = z.enum([
  "voice",
  "image",
  "video",
  "round-video",
  "file",
]);
export type AttachmentKind = z.infer<typeof attachmentKind>;

const hexHash = z.string().regex(/^[a-f0-9]{64}$/u);
const imageMime = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const videoMime = z.enum(["video/mp4", "video/quicktime"]);
const voiceMimes = z.enum([voiceMime, "audio/m4a", "audio/x-m4a"]);
const dimension = z.number().int().positive().max(8192);
const thumbhash = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
  .min(8)
  .max(48)
  .refine((hash) => {
    try {
      const bytes = atob(hash);
      if (bytes.length < 5) return false;
      const alpha = (bytes.charCodeAt(2) & 128) !== 0;
      const header = bytes.charCodeAt(3);
      const shortSide = header & 7;
      const longSide = alpha ? 5 : 7;
      if (!shortSide || shortSide > longSide) return false;
      let coefficients = 10 + (alpha ? 14 : 0);
      for (let y = 0; y < Math.max(3, shortSide); y++)
        for (
          let x = y === 0 ? 1 : 0;
          x * Math.max(3, shortSide) + y * longSide <
          longSide * Math.max(3, shortSide);
          x++
        )
          coefficients++;
      return bytes.length === (alpha ? 6 : 5) + Math.ceil(coefficients / 2);
    } catch {
      return false;
    }
  });
const blurhash = z
  .string()
  .min(6)
  .max(166)
  .refine((hash) => {
    const alphabet =
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";
    if (/^(?:file|data):/u.test(hash)) return false;
    const size = alphabet.indexOf(hash[0]);
    return (
      size >= 0 &&
      size <= 80 &&
      [...hash].every((char) => alphabet.includes(char)) &&
      hash.length === 4 + 2 * (1 + (size % 9)) * (1 + Math.floor(size / 9))
    );
  });
const filename = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (name) =>
      name !== "." &&
      name !== ".." &&
      !/[<>:"/\\|?*]/u.test(name) &&
      !/[\p{Cc}\p{Cf}]/u.test(name),
  );
const presentation = z.object({
  kind: attachmentKind,
  mime: z
    .string()
    .max(120)
    .regex(/^[a-z0-9][a-z0-9.+_-]*\/[a-z0-9][a-z0-9.+_-]*$/u),
  durationMs: z.number().int().positive().max(3_600_000).optional(),
  waveform: z.array(z.number().int().min(0).max(100)).max(64).optional(),
  dimensions: z.object({ width: dimension, height: dimension }).optional(),
  thumbhash: thumbhash.optional(),
  blurhash: blurhash.optional(),
  filename: filename.optional(),
  caption: z.string().max(2000).optional(),
});
const validKind = (file: z.infer<typeof presentation>) => {
  switch (file.kind) {
    case "voice":
      return (
        voiceMimes.safeParse(file.mime).success &&
        (file.durationMs ?? 0) <= maxVoiceDuration
      );
    case "image":
      return imageMime.safeParse(file.mime).success;
    case "round-video":
      return (
        videoMime.safeParse(file.mime).success &&
        (file.durationMs ?? 0) <= 61_000
      );
    case "video":
      return videoMime.safeParse(file.mime).success;
    case "file":
      return true;
  }
};
export const attachmentMetadata = presentation.refine(validKind);
export const voiceMetadata = presentation
  .extend({ kind: z.literal("voice"), mime: voiceMimes })
  .refine(validKind);
export type AttachmentMetadata = z.infer<typeof attachmentMetadata>;
export type VoiceMetadata = z.infer<typeof voiceMetadata>;
export function byteLimit(kind: AttachmentKind) {
  return kind === "voice" ? maxVoiceBytes : maxAttachmentBytes;
}

const downloadUrl = z
  .string()
  .refine((value) => !!publicMediaUrl(value) && !value.includes("#"));
const sealed = presentation.extend({
  algorithm: z.literal("aes-gcm"),
  key: hexHash,
  nonce: z.string().regex(/^(?:[a-f0-9]{24}|[a-f0-9]{32})$/u),
  hash: hexHash,
  originalHash: hexHash.optional(),
  size: z.number().int().min(17).max(maxAttachmentBytes).optional(),
  fallbacks: z.array(downloadUrl).max(3).optional(),
});
const validFile = (file: z.infer<typeof sealed>) =>
  validKind(file) && (file.size ?? 0) <= byteLimit(file.kind);
export const encryptedAttachment = sealed
  .extend({ url: downloadUrl })
  .refine(validFile);
export type EncryptedAttachment = z.infer<typeof encryptedAttachment>;
export type SealedAttachment = z.infer<typeof sealed>;

export function parseFileMessage(
  url: string,
  tags: string[][],
): EncryptedAttachment | null {
  const fields = new Map<string, string>();
  const names = new Set([
    "file-type",
    "encryption-algorithm",
    "decryption-key",
    "decryption-nonce",
    "x",
    "ox",
    "size",
    "dim",
    "thumbhash",
    "blurhash",
    "boop:media",
    "boop:media-version",
    "boop:duration-ms",
    "boop:waveform",
    "boop:filename",
    "boop:caption",
  ]);
  const fallbacks = new Set<string>();
  for (const [name, value] of tags) {
    if (
      name === "fallback" &&
      fallbacks.size < 3 &&
      downloadUrl.safeParse(value).success &&
      value !== url
    )
      fallbacks.add(value);
    if (!names.has(name)) continue;
    if (fields.has(name) || value === undefined) return null;
    fields.set(name, value);
  }
  const mime = fields.get("file-type");
  const version = fields.get("boop:media-version");
  const extension = (name: string) =>
    version === undefined || version === "1" ? fields.get(name) : undefined;
  const kind =
    extension("boop:media") ??
    (voiceMimes.safeParse(mime).success
      ? "voice"
      : imageMime.safeParse(mime).success
        ? "image"
        : videoMime.safeParse(mime).success
          ? "video"
          : "file");
  const size = fields.get("size");
  const ms = extension("boop:duration-ms");
  const samples = extension("boop:waveform");
  if (
    (size !== undefined && !/^\d{1,8}$/u.test(size)) ||
    (ms !== undefined && !/^\d{1,7}$/u.test(ms)) ||
    (samples !== undefined && !/^\d{1,3}(?:,\d{1,3}){0,63}$/u.test(samples))
  )
    return null;
  const dims = /^(\d{1,5})x(\d{1,5})$/u.exec(fields.get("dim") ?? "");
  const parsed = encryptedAttachment.safeParse({
    kind,
    mime,
    url,
    algorithm: fields.get("encryption-algorithm"),
    key: fields.get("decryption-key"),
    nonce: fields.get("decryption-nonce"),
    hash: fields.get("x"),
    originalHash: fields.get("ox"),
    size: size === undefined ? undefined : Number(size),
    durationMs: ms === undefined ? undefined : Number(ms),
    waveform: samples?.split(",").map(Number),
    dimensions:
      dims &&
      dimension.safeParse(Number(dims[1])).success &&
      dimension.safeParse(Number(dims[2])).success
        ? { width: Number(dims[1]), height: Number(dims[2]) }
        : undefined,
    thumbhash: thumbhash.safeParse(fields.get("thumbhash")).data,
    blurhash: blurhash.safeParse(fields.get("blurhash")).data,
    filename: filename.safeParse(extension("boop:filename")).data,
    caption: extension("boop:caption"),
    fallbacks: fallbacks.size ? [...fallbacks] : undefined,
  });
  return parsed.success ? parsed.data : null;
}

export function fileTags(file: EncryptedAttachment): string[][] {
  const tags = [
    ["file-type", file.mime],
    ["encryption-algorithm", file.algorithm],
    ["decryption-key", file.key],
    ["decryption-nonce", file.nonce],
    ["x", file.hash],
    ["boop:media", file.kind],
    ["boop:media-version", "1"],
  ];
  if (file.originalHash) tags.push(["ox", file.originalHash]);
  if (file.size) tags.push(["size", String(file.size)]);
  if (file.durationMs) tags.push(["boop:duration-ms", String(file.durationMs)]);
  if (file.waveform?.length)
    tags.push(["boop:waveform", file.waveform.join(",")]);
  if (file.dimensions)
    tags.push(["dim", `${file.dimensions.width}x${file.dimensions.height}`]);
  if (file.thumbhash) tags.push(["thumbhash", file.thumbhash]);
  if (file.blurhash) tags.push(["blurhash", file.blurhash]);
  if (file.filename) tags.push(["boop:filename", file.filename]);
  if (file.caption) tags.push(["boop:caption", file.caption]);
  for (const fallback of file.fallbacks ?? [])
    tags.push(["fallback", fallback]);
  return tags;
}

export function localAttachmentName(file: AttachmentMetadata) {
  switch (file.kind) {
    case "voice":
      return "voice.m4a";
    case "round-video":
    case "video":
      return file.mime === "video/quicktime" ? "video.mov" : "video.mp4";
    case "image":
      return (
        {
          "image/jpeg": "photo.jpg",
          "image/png": "photo.png",
          "image/webp": "photo.webp",
          "image/gif": "photo.gif",
        }[file.mime] ?? "photo"
      );
    case "file":
      return file.filename ?? "attachment";
  }
}
