import type { MessagingRepository } from "@/db/messaging";
import { messagingMetric } from "../diagnostics";
import {
  createTimeLockOpener,
  TimeLockError,
  type UnlockFailure,
} from "./timelock";

const retryDelays = [5_000, 15_000, 30_000, 60_000, 180_000, 300_000];
const maximumTimer = 2_147_000_000;
const permanent = new Set<UnlockFailure>([
  "ciphertext",
  "decryption",
  "plaintext",
]);

export function createUnlockScheduler(
  chat: MessagingRepository,
  open = createTimeLockOpener(),
) {
  let session: AbortController | undefined;
  let busy = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(yieldMs = 0) {
    clearTimeout(timer);
    if (!session || busy) return;
    try {
      const next = chat.nextUnlock();
      if (next !== null)
        timer = setTimeout(
          () => void run(),
          Math.max(yieldMs, Math.min(maximumTimer, next - Date.now())),
        );
    } catch {
      timer = setTimeout(() => void run(), 5_000);
    }
  }

  async function run() {
    if (!session || busy) return;
    busy = true;
    const { signal } = session;
    const roundFailures = new Map<number, TimeLockError>();
    let storageFailed = false;
    try {
      for (const item of chat.dueUnlocks(Date.now())) {
        if (signal.aborted) break;
        const started = performance.now();
        let body: string | null;
        try {
          const failed = roundFailures.get(item.content.unlockRound);
          if (failed) throw failed;
          body = await open(item.content, signal);
        } catch (error) {
          if (signal.aborted) break;
          if (!(error instanceof TimeLockError)) throw error;
          const fatal = permanent.has(error.code);
          if (!fatal) roundFailures.set(item.content.unlockRound, error);
          const delay =
            retryDelays[Math.min(item.attempts, retryDelays.length - 1)] ??
            300_000;
          chat.deferUnlock(item, error.code, fatal ? null : Date.now() + delay);
          continue;
        }
        if (signal.aborted || body === null) break;
        const write = performance.now();
        chat.commitUnlock(item, body, Date.now());
        messagingMetric("timelock opened", {
          verifyAndOpenMs: write - started,
          writeMs: performance.now() - write,
          cipherBytes: item.content.ciphertext.length,
        });
        // Give input and rendering a turn between pairing operations.
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    } catch {
      storageFailed = true;
    } finally {
      busy = false;
      schedule(storageFailed ? 5_000 : 32);
    }
  }

  return {
    setActive(next: boolean) {
      if (Boolean(session) === next) return;
      session?.abort();
      session = next ? new AbortController() : undefined;
      unsubscribe?.();
      unsubscribe = next
        ? chat.subscribe((change) => {
            if (change.unlockQueue) schedule();
          })
        : undefined;
      schedule();
    },
    reconnect() {
      if (!session) return;
      try {
        chat.resumeUnlocks(Date.now());
      } catch {
        // A later reconciliation retries when storage is available.
      }
      schedule();
    },
  };
}
