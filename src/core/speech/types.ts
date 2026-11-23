import type { Transcript } from "@hzblj/expo-speech";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";

export const localeTag = z.string().regex(/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i);
export const sourceSchema = z.object({
  target: z.tuple([
    z.string(),
    z.string(),
    z.string(),
    z.number().int().nonnegative(),
  ]),
  sender: z.string(),
  incoming: z.boolean(),
  hash: z.string().nullable(),
  expiresAt: z.number().nullable(),
  duration: z.number().positive().nullable(),
  sentAt: z.number().nonnegative(),
});
export type SpeechSource = z.infer<typeof sourceSchema>;

export const preferenceSchema = z.object({
  mode: z.enum(["off", "demand", "automatic"]).catch("demand"),
  incoming: z.boolean().catch(true),
  outgoing: z.boolean().catch(true),
  downloaded: z.boolean().catch(true),
  visibleFirst: z.boolean().catch(true),
  highlight: z.boolean().catch(true),
  charging: z.boolean().catch(false),
  respectLowPower: z.boolean().catch(true),
  modelDownloads: z.enum(["manual", "wifi"]).catch("manual"),
  maxDuration: z.number().int().min(15).max(600).catch(120),
  preferred: localeTag.nullable().catch(null),
  additional: z.array(localeTag).max(4).catch([]),
  recognitionMode: z
    .enum(["transcription", "dictation"])
    .catch("transcription"),
  punctuation: z.boolean().catch(true),
  alternatives: z.boolean().catch(false),
  masking: z.boolean().catch(true),
  vocabulary: z.string().max(1000).catch(""),
});
export type SpeechPreferences = z.infer<typeof preferenceSchema>;

const config = z.object({
  locale: localeTag,
  switches: z.array(localeTag).max(5),
  engine: z.enum(["analyzer", "recognizer", "android"]),
  mode: preferenceSchema.shape.recognitionMode,
  punctuation: z.boolean(),
  alternatives: z.boolean(),
  masking: z.boolean(),
  vocabulary: z.array(z.string()).max(40),
});
export type SpeechConfig = z.infer<typeof config>;

export const jobSchema = z.object({
  id: z.string(),
  source: sourceSchema,
  config,
  status: z.enum([
    "queued",
    "waitingForMedia",
    "waitingForModel",
    "waitingForPermission",
    "preparing",
    "transcribing",
    "completed",
    "empty",
    "failed",
    "unsupported",
    "cancelled",
  ]),
  priority: z.number().int(),
  attempts: z.number().int().nonnegative(),
  readyAt: z.number(),
  updated: z.number(),
  error: z.string().optional(),
});
export type SpeechJob = z.infer<typeof jobSchema>;

export const speechFormat = "expo-speech@0.4.0/required/1";
export const speechKeySlot = (account: string) => `boop.speech.v1.${account}`;
export const attachmentId = ({ target, hash }: SpeechSource) =>
  JSON.stringify([...target, hash]);

export function jobId(
  account: string,
  source: SpeechSource,
  options: SpeechConfig,
) {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([speechFormat, account, attachmentId(source), options]),
      ),
    ),
  );
}

const time = z
  .number()
  .min(0)
  .max(4 * 3600);
const range = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);
const confidence = z.number().min(0).max(1).nullable();
const timed = z.object({
  text: z.string(),
  start: time,
  end: time,
  range,
  confidence,
});
const word = timed.extend({ timing: z.enum(["measured", "estimated"]) });
const segment = timed.extend({
  isFinal: z.literal(true),
  language: localeTag.nullable(),
  alternatives: z.array(z.string().max(12000)).max(5),
  words: z.array(word).max(2500),
});
const finalTranscript = z.object({
  text: z.string().max(32000),
  locale: localeTag,
  segments: z.array(segment).max(500),
  words: z.array(word).max(5000),
  duration: time.nullable(),
});
export type StoredTranscript = Omit<Transcript, "audioUri">;

export function validateTranscript(value: unknown): StoredTranscript {
  const result = finalTranscript.parse(value);
  const { text, duration, words, segments } = result;
  function ordered(
    items: readonly z.infer<typeof timed>[],
    begin: number,
    end: number,
  ) {
    let previousRange = begin;
    let previousStart = 0;
    return items.every((item) => {
      const [a, b] = item.range;
      const ok =
        a >= previousRange &&
        b >= a &&
        b <= end &&
        item.text === text.slice(a, b) &&
        item.start >= previousStart &&
        item.end >= item.start &&
        (duration === null || item.end <= duration + 1);
      previousRange = b;
      previousStart = item.start;
      return ok;
    });
  }
  const segmentWords = segments.flatMap((part) => part.words);
  if (
    !ordered(words, 0, text.length) ||
    !ordered(segments, 0, text.length) ||
    segments.map((part) => part.text).join("") !== text ||
    segments.some((part) => !ordered(part.words, ...part.range)) ||
    segmentWords.length !== words.length ||
    segmentWords.some(
      (item, index) => JSON.stringify(item) !== JSON.stringify(words[index]),
    ) ||
    JSON.stringify(result).length > 750_000
  )
    throw new Error("Invalid speech timings");
  return result;
}
