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
const liveBurst = 4;

export function createInboxIngestion<Event>(
  process: (event: unknown, active: () => boolean) => Promise<Event | null>,
  persist: (event: Event) => void,
) {
  const processed = new Set<string>();
  const pending = new Set<Promise<void>>();
  type Job = () => Promise<void>;
  const live: (Job | undefined)[] = [];
  const stored: (Job | undefined)[] = [];
  let liveHead = 0;
  let storedHead = 0;
  let running = false;
  let batch = 0;
  let workMs = 0;

  async function drain() {
    let servedLive = 0;
    while (liveHead < live.length || storedHead < stored.length) {
      if (batch >= batchLimit || workMs >= sliceMs) {
        batch = 0;
        workMs = 0;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const useLive =
        liveHead < live.length &&
        (storedHead >= stored.length || servedLive < liveBurst);
      const queue = useLive ? live : stored;
      const index = useLive ? liveHead++ : storedHead++;
      const job = queue[index];
      queue[index] = undefined;
      if (!job) continue;
      servedLive = useLive ? servedLive + 1 : 0;
      if (liveHead === live.length) {
        live.length = 0;
        liveHead = 0;
      }
      if (storedHead === stored.length) {
        stored.length = 0;
        storedHead = 0;
      }
      await job();
    }
    running = false;
  }

  return {
    receive(
      id: string,
      event: unknown,
      active: () => boolean,
      onError: () => void,
      realtime = false,
    ) {
      if (processed.has(id)) return;
      let done: () => void = () => undefined;
      const completion = new Promise<void>((resolve) => {
        done = resolve;
      });
      pending.add(completion);
      const queue = realtime ? live : stored;
      queue.push(async () => {
        try {
          if (!active() || processed.has(id)) return;
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
        } catch {
          onError();
        } finally {
          pending.delete(completion);
          done();
        }
      });
      if (!running) {
        running = true;
        queueMicrotask(() => void drain());
      }
    },
    drained: () => Promise.all(pending),
    queued: () => pending.size,
  };
}
