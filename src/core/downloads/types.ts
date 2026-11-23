import { z } from "zod";
import { sourceSchema as voiceSourceSchema } from "../speech/types";

export const targetSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.number().int().nonnegative(),
]);

export const sourceSchema = z.object({
  target: targetSchema,
  name: z.string(),
  type: z.string(),
  total: z.number().nonnegative().nullable(),
  sender: z.string(),
  voice: voiceSourceSchema.optional(),
  hash: z.string().nullish(),
  expiresAt: z.number().nullable(),
});

export const jobSchema = sourceSchema.extend({
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
});

export type DownloadSource = z.infer<typeof sourceSchema>;
export type DownloadJob = z.infer<typeof jobSchema>;
export type DownloadItem = DownloadJob & {
  speed: number;
  verifying: boolean;
  nativeState?: string;
};
export type DownloadTarget = z.infer<typeof targetSchema>;

export const downloadId = (target: DownloadTarget) => JSON.stringify(target);

export function isPending(job: DownloadJob) {
  return ["active", "queued", "waiting", "paused"].includes(job.state);
}

export function canReorder(job: DownloadJob) {
  return job.state === "queued" || job.state === "waiting";
}
