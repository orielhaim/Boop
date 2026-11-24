import { z } from "zod";

const storageFileGroups = [
  "profileCache",
  "profileLocal",
  "linkPreviews",
  "marmot",
  "database",
  "other",
] as const;

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nativeUsage = z.object({
  files: z.partialRecord(z.enum(storageFileGroups), bytes),
  partial: z.boolean(),
  freeBytes: bytes.optional(),
  traffic: z.object({ received: bytes, sent: bytes }).optional(),
});

export type NativeUsage = z.infer<typeof nativeUsage>;
export type StorageCategory = (typeof storageFileGroups)[number] | "downloads";

export function storageBreakdown(
  files: NativeUsage["files"],
  reportedAttachments?: number,
) {
  const marmot = files.marmot ?? 0;
  const validated = bytes.safeParse(reportedAttachments);
  const downloads =
    validated.success && validated.data <= marmot ? validated.data : undefined;
  const categories = {
    downloads,
    profileCache: files.profileCache ?? 0,
    profileLocal: files.profileLocal ?? 0,
    linkPreviews: files.linkPreviews ?? 0,
    marmot: marmot - (downloads ?? 0),
    database: files.database ?? 0,
    other: files.other ?? 0,
  } satisfies Record<StorageCategory, number | undefined>;
  const total = Object.values(categories).reduce<number>(
    (sum, size) => sum + (size ?? 0),
    0,
  );
  return { categories, total };
}
