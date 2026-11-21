import { z } from "zod";
import { publicMediaUrl } from "./url";

export const fileMessageKind = 15;
export const voiceMime = "audio/mp4";
export const maxVoiceDuration = 300_000;
export const minVoiceDuration = 450;
export const maxAttachmentBytes = 8 * 1024 * 1024;
const hexHash = z.string().regex(/^[a-f0-9]{64}$/u);
const duration = z.number().int().positive().max(maxVoiceDuration);
const waveform = z.array(z.number().int().min(0).max(100)).max(64);
export const voiceMetadata = z.object({
  kind: z.literal("voice"),
  mime: z.enum([voiceMime, "audio/m4a", "audio/x-m4a"]),
  durationMs: duration.optional(),
  waveform: waveform.optional(),
});
const wireFile = z.object({
  url: z
    .string()
    .refine((value) => !!publicMediaUrl(value) && !value.includes("#")),
  algorithm: z.literal("aes-gcm"),
  key: hexHash,
  nonce: z.string().regex(/^(?:[a-f0-9]{24}|[a-f0-9]{32})$/u),
  hash: hexHash,
  originalHash: hexHash.optional(),
  size: z.number().int().min(17).max(maxAttachmentBytes).optional(),
});
export const voiceAttachment = voiceMetadata.and(wireFile);
export type VoiceMetadata = z.infer<typeof voiceMetadata>;
export type VoiceAttachment = z.infer<typeof voiceAttachment>;
export type SealedAttachment = Omit<VoiceAttachment, "url">;

export function parseFileMessage(
  url: string,
  tags: string[][],
): VoiceAttachment | null {
  const fields = new Map<string, string>();
  const names = new Set([
    "file-type",
    "encryption-algorithm",
    "decryption-key",
    "decryption-nonce",
    "x",
    "ox",
    "size",
    "boop:media",
    "boop:duration-ms",
    "boop:waveform",
  ]);
  for (const [name, value] of tags) {
    if (!names.has(name)) continue;
    if (fields.has(name) || value === undefined) return null;
    fields.set(name, value);
  }
  const kind = fields.get("boop:media") ?? "voice";
  const size = fields.get("size");
  const ms = fields.get("boop:duration-ms");
  const samples = fields.get("boop:waveform");
  if (
    (size !== undefined && !/^\d{1,8}$/u.test(size)) ||
    (ms !== undefined && !/^\d{1,6}$/u.test(ms)) ||
    (samples !== undefined && !/^\d{1,3}(?:,\d{1,3}){0,63}$/u.test(samples))
  )
    return null;
  const parsed = voiceAttachment.safeParse({
    kind,
    mime: fields.get("file-type"),
    url,
    algorithm: fields.get("encryption-algorithm"),
    key: fields.get("decryption-key"),
    nonce: fields.get("decryption-nonce"),
    hash: fields.get("x"),
    originalHash: fields.get("ox"),
    size: size === undefined ? undefined : Number(size),
    durationMs: ms === undefined ? undefined : Number(ms),
    waveform: samples?.split(",").map(Number),
  });
  return parsed.success ? parsed.data : null;
}

export function fileTags(file: VoiceAttachment): string[][] {
  const tags = [
    ["file-type", file.mime],
    ["encryption-algorithm", file.algorithm],
    ["decryption-key", file.key],
    ["decryption-nonce", file.nonce],
    ["x", file.hash],
    ["boop:media", file.kind],
  ];
  if (file.originalHash) tags.push(["ox", file.originalHash]);
  if (file.size) tags.push(["size", String(file.size)]);
  if (file.durationMs) tags.push(["boop:duration-ms", String(file.durationMs)]);
  if (file.waveform?.length)
    tags.push(["boop:waveform", file.waveform.join(",")]);
  return tags;
}
