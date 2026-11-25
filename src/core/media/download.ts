import type { DownloadManager } from "@/core/downloads/manager";
import { sourceId, type DownloadSource } from "@/core/downloads/types";

export class PlaybackDownloadCancelled extends Error {}

export function waitForDownload(
  downloads: Pick<DownloadManager, "get" | "subscribe">,
  source: DownloadSource,
  signal: AbortSignal,
) {
  const id = sourceId(source);
  return new Promise<void>((resolve, reject) => {
    function finish(error?: Error) {
      unsubscribe();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    function abort() {
      finish(new PlaybackDownloadCancelled());
    }
    function check() {
      const job = downloads.get(id);
      if (
        signal.aborted ||
        job?.intent ||
        job?.state === "paused" ||
        job?.state === "cancelled"
      )
        abort();
      else if (!job || job.state === "failed")
        finish(new Error("AudioUnavailable"));
      else if (job.state === "completed") finish();
    }
    const unsubscribe = downloads.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}
