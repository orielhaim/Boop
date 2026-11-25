import { z } from "zod";

export const torrentId = z.string().regex(/^[a-f0-9]{40}$/u);
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const torrentFile = z.object({
  index: z.number().int().min(0).max(1023),
  path: z.array(z.string().min(1).max(255)).min(1).max(16),
  size,
});

export const torrentMetadata = z
  .object({
    torrentId,
    name: z.string().min(1).max(255),
    files: z.array(torrentFile).min(1).max(1024),
    metadata: z
      .string()
      .min(1)
      .max(699_052)
      .regex(/^[a-zA-Z0-9+/]+={0,2}$/u),
  })
  .superRefine(({ files }, context) => {
    if (new Set(files.map(({ index }) => index)).size !== files.length) {
      context.addIssue({
        code: "custom",
        message: "Duplicate torrent file index",
      });
    }
    if (
      !Number.isSafeInteger(files.reduce((total, file) => total + file.size, 0))
    ) {
      context.addIssue({
        code: "custom",
        message: "Torrent size out of range",
      });
    }
  });

export const engineResponse = z.union([
  z.object({ kind: z.literal("resolved") }).and(torrentMetadata),
  z.object({ kind: z.literal("progress"), received: size }),
  z.object({ kind: z.literal("failed"), code: z.string().max(64) }),
  z.object({ kind: z.enum(["pending", "completed", "stopped"]) }),
]);

export type TorrentMetadata = z.infer<typeof torrentMetadata>;
export type TorrentFile = z.infer<typeof torrentFile>;
export type EngineResult = z.infer<typeof engineResponse>;
export type TorrentSummary = Omit<TorrentMetadata, "metadata">;

export type EngineCommand =
  | { kind: "resolve"; requestId: string; magnet: string; torrentId: string }
  | {
      kind: "start";
      requestId: string;
      torrentId: string;
      fileIndex: number;
      size: number;
      metadata: string;
    }
  | { kind: "cancel" | "poll" | "stop"; requestId: string }
  | { kind: "forget"; torrentId: string }
  | { kind: "shutdown" };
