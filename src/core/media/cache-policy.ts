export function cacheEvictions<T extends { size: number; accessedAt: number }>(
  oldestFirst: T[],
  limits: { maxBytes: number; maxEntries?: number; expiresBefore?: number },
  pinned?: (entry: T) => boolean,
) {
  let remainingBytes = oldestFirst.reduce((sum, entry) => sum + entry.size, 0);
  let remainingEntries = oldestFirst.length;
  const evict: T[] = [];
  for (const entry of oldestFirst) {
    const old =
      limits.expiresBefore !== undefined &&
      entry.accessedAt < limits.expiresBefore;
    if (
      !old &&
      remainingBytes <= limits.maxBytes &&
      remainingEntries <= (limits.maxEntries ?? Infinity)
    )
      break;
    if (pinned?.(entry)) continue;
    evict.push(entry);
    remainingBytes -= entry.size;
    remainingEntries--;
  }
  return { evict, remainingBytes };
}
