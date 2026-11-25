import { z } from "zod";
import { sourceSchema as voiceSourceSchema } from "../speech/types";

const targetSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.number().int().nonnegative(),
]);
const metadata = z.object({
  name: z.string(),
  type: z.string(),
  total: z.number().nonnegative().nullable(),
  hash: z.string().nullish(),
  expiresAt: z.number().nullable(),
});
const marmotSource = metadata.extend({
  kind: z.literal("marmot"),
  target: targetSchema,
  sender: z.string(),
  voice: voiceSourceSchema.optional(),
});
const providerSource = metadata
  .extend({
    kind: z.literal("provider"),
    provider: z.string().min(1).max(64),
    version: z.number().int().positive(),
    payload: z.unknown(),
  })
  .passthrough();
export const torrentsSource = providerSource.extend({
  provider: z.literal("torrents"),
  version: z.literal(1),
  payload: z.object({
    torrentId: z.string().regex(/^[a-f0-9]{40}$/u),
    fileIndex: z.number().int().nonnegative(),
  }),
});
export const blossomSource = metadata.extend({
  kind: z.literal("http"),
  artifact: z.literal("blossom"),
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
  total: z
    .number()
    .int()
    .min(0)
    .max(1024 ** 3)
    .nullable(),
  expectedSize: z
    .number()
    .int()
    .min(0)
    .max(1024 ** 3)
    .nullable(),
  urls: z.array(z.string().max(2048)).max(8),
  authors: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(3),
});
export const sourceSchema = z.discriminatedUnion("kind", [
  marmotSource,
  blossomSource,
  providerSource,
]);
const jobFields = {
  id: z.string(),
  state: z.enum([
    "queued",
    "active",
    "paused",
    "waiting",
    "failed",
    "completed",
    "cancelled",
  ]),
  received: z.number().nonnegative(),
  createdAt: z.number(),
  changedAt: z.number(),
  order: z.number(),
  retries: z.number().int().nonnegative(),
  retryAt: z.number(),
  issue: z
    .enum(["unavailable", "storage", "interrupted", "transfer"])
    .optional(),
  intent: z.enum(["pause", "cancel", "remove"]).optional(),
};
export const jobSchema = z.discriminatedUnion("kind", [
  marmotSource.extend(jobFields),
  blossomSource.extend(jobFields),
  providerSource.extend(jobFields),
]);

export type DownloadSource = z.infer<typeof sourceSchema>;
export type MarmotDownload = z.infer<typeof marmotSource>;
export type BlossomDownload = z.infer<typeof blossomSource>;
export type ProviderDownload = z.infer<typeof providerSource>;
export type TorrentsDownload = z.infer<typeof torrentsSource>;
export type DownloadJob = z.infer<typeof jobSchema>;
export type DownloadItem = DownloadJob & {
  speed: number;
  verifying: boolean;
  nativeState?: string;
};
export type DownloadTarget = z.infer<typeof targetSchema>;

export const downloadId = (target: DownloadTarget) => JSON.stringify(target);
export const sourceId = (source: DownloadSource) =>
  source.kind === "marmot"
    ? downloadId(source.target)
    : source.kind === "http"
      ? `http:blossom:${source.hash}`
      : providerKey(source);

export function providerKey(source: ProviderDownload) {
  if (source.provider === "torrents" && source.version === 1) {
    const payload = torrentsSource.parse(source).payload;
    return `provider:torrents:1:${payload.torrentId}:${payload.fileIndex}`;
  }
  return `provider:${source.provider}:${source.version}:${stableJson(source.payload)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export function isPending(job: DownloadJob) {
  return ["active", "queued", "waiting", "paused"].includes(job.state);
}

export function canReorder(job: DownloadJob) {
  return !job.intent && (job.state === "queued" || job.state === "waiting");
}
