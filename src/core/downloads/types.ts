import { z } from "zod";
import { sourceSchema as voiceSourceSchema } from "../speech/types";

export const targetSchema = z.tuple([
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
const httpSource = metadata.extend({
  kind: z.literal("http"),
  artifact: z.literal("boop-license"),
});
export const sourceSchema = z.discriminatedUnion("kind", [
  marmotSource,
  httpSource,
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
  httpSource.extend(jobFields),
]);

export type DownloadSource = z.infer<typeof sourceSchema>;
export type MarmotDownload = z.infer<typeof marmotSource>;
export type HttpDownload = z.infer<typeof httpSource>;
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
    : `http:${source.artifact}`;

export function isPending(job: DownloadJob) {
  return ["active", "queued", "waiting", "paused"].includes(job.state);
}

export function canReorder(job: DownloadJob) {
  return !job.intent && (job.state === "queued" || job.state === "waiting");
}
