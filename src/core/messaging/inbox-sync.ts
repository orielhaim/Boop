const day = 24 * 60 * 60;
export const giftWrapOverlap = 3 * day;
const auditInterval = 7 * day;
const auditLookback = 30 * day;

export function inboxCatchup(
  beganAt: number,
  raw: string | null,
  legacy: string | null,
) {
  const [saved, audited] = (raw ?? legacy ?? "").split(":").map(Number);
  const checkpoint =
    Number.isSafeInteger(saved) && saved > 0 && saved <= beganAt ? saved : 0;
  const lastAudit =
    Number.isSafeInteger(audited) && audited > 0 && audited <= beganAt
      ? audited
      : 0;
  const audit = !checkpoint || beganAt - lastAudit >= auditInterval;
  return {
    since: checkpoint
      ? Math.max(
          0,
          Math.min(
            checkpoint - giftWrapOverlap,
            audit ? beganAt - auditLookback : Infinity,
          ),
        )
      : undefined,
    checkpoint: `${beganAt}:${audit ? beganAt : lastAudit}`,
  };
}

const processedLimit = 4_096;
const batchLimit = 16;
const sliceMs = 6;

export function createInboxIngestion<Event>(
  process: (event: unknown, active: () => boolean) => Promise<Event | null>,
  persist: (event: Event) => void,
) {
  let tail = Promise.resolve();
  const processed = new Set<string>();
  let queued = 0;
  let batch = 0;
  let workMs = 0;

  return {
    receive(
      id: string,
      event: unknown,
      active: () => boolean,
      onError: () => void,
    ) {
      if (processed.has(id)) return;
      queued++;
      tail = tail
        .then(async () => {
          if (!active() || processed.has(id)) return;
          if (batch >= batchLimit || workMs >= sliceMs) {
            batch = 0;
            workMs = 0;
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (!active()) return;
          }
          batch++;
          const started = performance.now();
          try {
            const value = await process(event, active);
            if (value === null || !active()) return;
            persist(value);
          } finally {
            workMs += performance.now() - started;
          }
          processed.add(id);
          if (processed.size > processedLimit) {
            const oldest = processed.values().next().value;
            if (oldest !== undefined) processed.delete(oldest);
          }
        })
        .catch(onError)
        .finally(() => {
          queued--;
        });
    },
    drained: () => tail,
    queued: () => queued,
  };
}
