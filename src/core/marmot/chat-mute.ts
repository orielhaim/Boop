const hourMs = 3_600_000;

export const chatMuteDurations = [
  { label: "oneHour", ms: hourMs },
  { label: "eightHours", ms: 8 * hourMs },
  { label: "day", ms: 24 * hourMs },
  { label: "week", ms: 7 * 24 * hourMs },
  { label: "forever", ms: null },
] as const;

export function isChatMuted(
  chat: { muted: boolean; mutedUntilMs?: number | null },
  now: number,
) {
  return chat.muted && (chat.mutedUntilMs == null || chat.mutedUntilMs > now);
}

export async function muteChats(
  groups: readonly string[],
  durationMs: number | null,
  setMuted: (group: string, until: number | null) => Promise<void>,
) {
  const until = durationMs == null ? null : Date.now() + durationMs;
  const results = await Promise.allSettled(
    groups.map(async (group) => setMuted(group, until)),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}
