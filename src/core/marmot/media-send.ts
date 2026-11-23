import type { MarmotConversation, MarmotUpload } from "./native";

// Expo's native string maps cannot represent undefined values.
export function mediaUploadArguments(files: readonly MarmotUpload[]) {
  return files.map(
    ({
      path,
      name,
      type,
      dimensions,
      thumbhash,
      duration,
      waveform,
      presentation,
    }): Record<string, string> => ({
      path,
      name,
      type,
      ...(dimensions !== undefined && { dimensions }),
      ...(thumbhash !== undefined && { thumbhash }),
      ...(duration !== undefined && { duration }),
      ...(waveform !== undefined && { waveform }),
      ...(presentation !== undefined && { presentation }),
    }),
  );
}

export async function waitForAttachmentForeground(
  foreground: { get(): boolean; subscribe(notify: () => void): () => void },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (foreground.get()) return;
  await new Promise<void>((resolve, reject) => {
    const dispose = () => {
      unsubscribe();
      signal.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      dispose();
      reject(signal.reason);
    };
    const resume = () => {
      if (!foreground.get()) return;
      dispose();
      resolve();
    };
    const unsubscribe = foreground.subscribe(resume);
    signal.addEventListener("abort", cancel, { once: true });
    resume();
  });
}

export function pendingMediaDraft(draft: MarmotConversation["draft"]) {
  const files = draft?.attachments;
  if (!files?.length) return undefined;
  const first = files[0];
  const [token, count] = first?.id.split(":") ?? [];
  if (
    !first ||
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
    ...(files.length === 1 &&
      first.id === `${token}:1:0:voice` && {
        voice: { duration: first.duration, waveform: first.waveform },
      }),
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
