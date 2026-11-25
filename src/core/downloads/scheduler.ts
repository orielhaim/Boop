import { canReorder, torrentsSource, type DownloadItem } from "./types";

export function contentKey(job: DownloadItem) {
  if (job.kind === "provider") {
    const torrent = torrentsSource.safeParse(job);
    if (torrent.success) return `torrent:${torrent.data.payload.torrentId}`;
  }
  if (!job.hash) return undefined;
  return job.kind === "marmot"
    ? `marmot:${job.hash}`
    : job.kind === "http"
      ? `${job.artifact}:${job.hash}`
      : undefined;
}

export function selectDownloads(
  ordered: DownloadItem[],
  occupied: ReadonlySet<string>,
  capacity: number,
  now: number,
  priority: ReadonlySet<string> = new Set(),
) {
  const ready: DownloadItem[] = [];
  const hashes = new Set(
    ordered
      .filter((job) => occupied.has(job.id))
      .map(contentKey)
      .filter(Boolean),
  );
  let wakeAt = Infinity;
  const candidates = priority.size
    ? [...ordered].sort(
        (a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)),
      )
    : ordered;
  for (const job of candidates) {
    const hash = contentKey(job);
    if (job.expiresAt !== null && job.expiresAt > now)
      wakeAt = Math.min(wakeAt, job.expiresAt);
    if (!canReorder(job) || occupied.has(job.id) || (hash && hashes.has(hash)))
      continue;
    if (job.retryAt > now) {
      wakeAt = Math.min(wakeAt, job.retryAt);
    } else if (ready.length < capacity) {
      ready.push(job);
      if (hash) hashes.add(hash);
    }
  }
  return { ready, wakeAt };
}
