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
]);

export type DownloadSource = z.infer<typeof sourceSchema>;
export type MarmotDownload = z.infer<typeof marmotSource>;
export type BlossomDownload = z.infer<typeof blossomSource>;
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
    : `http:blossom:${source.hash}`;

export function isPending(job: DownloadJob) {
  return ["active", "queued", "waiting", "paused"].includes(job.state);
}

export function canReorder(job: DownloadJob) {
  return !job.intent && (job.state === "queued" || job.state === "waiting");
}
