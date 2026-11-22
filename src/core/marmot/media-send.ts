import { z } from "zod";
import type { MarmotConversation, MarmotMessage } from "./native";

export const attachmentMetadataKind = 24885;
const attachmentMetadata = z.strictObject({
  index: z.number().int().min(0).max(15),
  size: z.number().int().positive(),
  duration: z.number().int().min(1).max(3_600).optional(),
  waveform: z.array(z.number().int().min(0).max(31)).max(64).optional(),
  round: z.literal(true).optional(),
});
const metadata = z.strictObject({
  target: z.string().regex(/^[a-f0-9]{64}$/),
  attachments: z.array(attachmentMetadata).min(1).max(16),
});
export type AttachmentMetadata = z.infer<typeof attachmentMetadata>;

export function pendingMediaDraft(draft: MarmotConversation["draft"]) {
  const files = draft?.attachments;
  if (!files?.length) return undefined;
  const first = files[0];
  const [token, count] = first?.id.split(":") ?? [];
  if (
    !token ||
    !/^[a-f0-9-]{36}$/i.test(token) ||
    Number(count) !== files.length ||
    !files.every((file, index) =>
      file.id.startsWith(`${token}:${count}:${index}:`),
    )
  )
    return { kind: "incomplete" } as const;
  const attachments = files.map((file, index): AttachmentMetadata => ({
    index,
    size: file.size,
    duration:
      file.duration == null
        ? undefined
        : Math.min(3600, Math.max(1, Math.round(file.duration))),
    waveform: file.waveform.map((level) =>
      Math.round(Math.min(1, Math.max(0, level)) * 31),
    ),
    round: file.id.endsWith(":round") ? true : undefined,
  }));
  return { kind: "ready", token, attachments } as const;
}

export function attachmentMetadataEvent(
  target: string,
  attachments: AttachmentMetadata[],
) {
  return JSON.stringify(metadata.parse({ target, attachments }));
}

export function applyAttachmentMetadata(rows: readonly MarmotMessage[]) {
  const reports = new Map<string, AttachmentMetadata[]>();
  for (const row of rows) {
    if (
      row.eventKind !== attachmentMetadataKind ||
      row.deleted ||
      row.invalidated ||
      row.text.length > 6_000
    )
      continue;
    try {
      const report = metadata.parse(JSON.parse(row.text));
      reports.set(`${row.sender}:${report.target}`, report.attachments);
    } catch {
      // Ignore malformed optional presentation metadata.
    }
  }
  return rows
    .filter((row) => row.eventKind !== attachmentMetadataKind)
    .map((row) => {
      const report = reports.get(`${row.sender}:${row.id}`);
      if (!report?.length) return row;
      return {
        ...row,
        attachments: row.attachments.map((item) => {
          const meta = report.find(({ index }) => index === item.index);
          return meta
            ? {
                ...item,
                size: meta.size,
                duration: meta.duration ?? item.duration,
                waveform: meta.waveform ?? item.waveform,
                round: meta.round ?? item.round,
              }
            : item;
        }),
      };
    });
}

export async function sendOnAttachmentServers<Result>({
  origins,
  isEnabled,
  signal,
  check,
  send,
}: {
  origins: readonly string[];
  isEnabled: (origin: string) => boolean;
  signal: AbortSignal;
  check: (origin: string) => Promise<unknown>;
  send: (origin: string) => Promise<Result>;
}) {
  let last: unknown = new Error("MediaNotConfigured");
  for (const origin of origins) {
    signal.throwIfAborted();
    if (!isEnabled(origin)) continue;
    try {
      await check(origin);
    } catch (reason) {
      last = reason;
      continue;
    }
    signal.throwIfAborted();
    if (!isEnabled(origin)) continue;
    try {
      return await send(origin);
    } catch (reason) {
      if (
        typeof reason !== "object" ||
        !reason ||
        !("code" in reason) ||
        reason.code !== "UploadEndpointFailed"
      )
        throw reason;
      last = reason;
    }
  }
  throw last;
}
