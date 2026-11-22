import type { MarmotConversation } from "./native";

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
  return {
    kind: "ready",
    token,
    sizes: files.map(({ size }) => size),
  } as const;
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
