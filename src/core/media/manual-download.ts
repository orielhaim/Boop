import {
  byteLimit,
  encryptedAttachment,
  type EncryptedAttachment,
} from "./protocol";

export function createManualDownloads<TResult>(options: {
  authorize(peer: string, id: string): EncryptedAttachment | undefined;
  transfer(
    file: EncryptedAttachment,
    signal: AbortSignal,
    limit: number,
    peer: string,
    id: string,
  ): Promise<TResult>;
}) {
  const jobs = new Map<
    string,
    { peer: string; abort: AbortController; result: Promise<TResult> }
  >();
  return {
    download(peer: string, id: string) {
      const key = `${peer}:${id}`;
      const existing = jobs.get(key);
      if (existing) return existing.result;
      const file = encryptedAttachment.safeParse(options.authorize(peer, id));
      if (!file.success || jobs.size >= 3)
        return Promise.reject(new Error("media-unavailable"));
      const abort = new AbortController();
      const result = Promise.resolve()
        .then(() => {
          if (abort.signal.aborted) throw new Error("media-cancelled");
          return options.transfer(
            file.data,
            abort.signal,
            file.data.size ?? byteLimit(file.data.kind),
            peer,
            id,
          );
        })
        .finally(() => jobs.delete(key));
      jobs.set(key, { peer, abort, result });
      return result;
    },
    cancel(peer: string, id: string) {
      jobs.get(`${peer}:${id}`)?.abort.abort();
    },
    cancelAll(peer?: string) {
      for (const job of jobs.values())
        if (!peer || job.peer === peer) job.abort.abort();
    },
  };
}
