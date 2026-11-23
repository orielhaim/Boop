import { canReorder, type DownloadItem } from "./types";

export function selectDownloads(
  ordered: DownloadItem[],
  occupied: ReadonlySet<string>,
  capacity: number,
  now: number,
) {
  const ready: DownloadItem[] = [];
  const hashes = new Set(
    ordered
      .filter((job) => occupied.has(job.id))
      .map((job) => job.hash)
      .filter(Boolean),
  );
  let wakeAt = Infinity;
  for (const job of ordered) {
    if (job.expiresAt !== null && job.expiresAt > now)
      wakeAt = Math.min(wakeAt, job.expiresAt);
    if (
      !canReorder(job) ||
      occupied.has(job.id) ||
      (job.hash && hashes.has(job.hash))
    )
      continue;
    if (job.retryAt > now) {
      wakeAt = Math.min(wakeAt, job.retryAt);
    } else if (ready.length < capacity) {
      ready.push(job);
      if (job.hash) hashes.add(job.hash);
    }
  }
  return { ready, wakeAt };
}
