import { z } from "zod";
import { opaqueId } from "./protocol";

export const mediaTurn = z.strictObject({
  version: z.literal(1),
  callId: opaqueId,
  token: opaqueId,
});
export const mediaTurnTimeout = 7_000;

export function createMediaTurns() {
  let tail = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>) {
    const next = tail.then(task);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  let remote: { token: string; end: () => void } | undefined;
  return {
    enqueue,
    grant(token: string, request: AbortSignal, call: AbortSignal) {
      const granted = Promise.withResolvers<boolean>();
      void enqueue(async () => {
        if (request.aborted || call.aborted) {
          granted.resolve(false);
          return;
        }
        const done = Promise.withResolvers<void>();
        const end = () => done.resolve();
        const timer = setTimeout(end, mediaTurnTimeout + 1_000);
        remote = { token, end };
        call.addEventListener("abort", end, { once: true });
        granted.resolve(true);
        try {
          await done.promise;
        } finally {
          clearTimeout(timer);
          call.removeEventListener("abort", end);
          remote = undefined;
        }
      });
      return granted.promise;
    },
    release(token: string) {
      if (remote?.token === token) remote.end();
    },
  };
}
