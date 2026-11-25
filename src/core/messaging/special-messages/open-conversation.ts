import {
  createTimeLockOpener,
  parseTimeLock,
  TimeLockError,
  type TimeLockContent,
  type UnlockFailure,
} from "./timelock";

type Message = {
  id: string;
  text: string;
  expiresAt?: number | null;
};

export type OpenLaterState =
  | { kind: "locked"; requestedAt: number }
  | { kind: "opening"; requestedAt: number }
  | { kind: "failed"; requestedAt: number; error: UnlockFailure }
  | { kind: "opened"; text: string }
  | { kind: "invalid" };

type Entry = {
  message: Message;
  payload?: TimeLockContent;
  state: OpenLaterState;
  retryAt?: number;
  attempts: number;
};

const maxTimerDelay = 2_147_000_000;

function readPayload(text: string) {
  try {
    return parseTimeLock(JSON.parse(text));
  } catch {
    return null;
  }
}

export function createOpenLaterResolver({
  read,
  save,
  allowed,
  publish,
  now = Date.now,
  open = createTimeLockOpener(),
}: {
  read: (message: Message) => string | null;
  save: (message: Message, text: string) => void;
  allowed: (message: Message) => boolean;
  publish: (states: ReadonlyMap<string, OpenLaterState>) => void;
  now?: () => number;
  open?: ReturnType<typeof createTimeLockOpener>;
}) {
  const entries = new Map<string, Entry>();
  const lifetime = new AbortController();
  const queue = new Set<Entry>();
  let running = 0;
  let initialized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = (message: Message) =>
    message.expiresAt != null && message.expiresAt * 1_000 <= now();

  function emit() {
    if (!lifetime.signal.aborted)
      publish(new Map([...entries].map(([id, entry]) => [id, entry.state])));
  }

  function eligible(entry: Entry) {
    return (
      !lifetime.signal.aborted &&
      entries.get(entry.message.id) === entry &&
      !expired(entry.message) &&
      allowed(entry.message)
    );
  }

  function pump() {
    for (const entry of queue) {
      if (running >= 2) break;
      queue.delete(entry);
      const { payload, message } = entry;
      if (!payload || !eligible(entry)) continue;
      running++;
      void open(payload, lifetime.signal)
        .then((text) => {
          if (text === null || !eligible(entry)) return;
          save(message, text);
          entry.state = { kind: "opened", text };
        })
        .catch((reason: unknown) => {
          if (!eligible(entry)) return;
          const error =
            reason instanceof TimeLockError ? reason.code : "decryption";
          entry.state = {
            kind: "failed",
            requestedAt: payload.requestedAt,
            error,
          };
          if (
            error === "not-ready" ||
            error === "network" ||
            error === "endpoint"
          )
            entry.retryAt =
              now() + Math.min(60_000, 3_000 * 2 ** entry.attempts++);
        })
        .finally(() => {
          running--;
          emit();
          pump();
          schedule();
        });
    }
  }

  function enqueue(entry: Entry) {
    const { payload } = entry;
    if (!payload || !eligible(entry) || now() < payload.roundTime) return false;
    entry.retryAt = undefined;
    entry.state = { kind: "opening", requestedAt: payload.requestedAt };
    queue.add(entry);
    return true;
  }

  function refresh(messages: readonly Message[]) {
    if (lifetime.signal.aborted) return;
    const loaded = new Map(messages.map((message) => [message.id, message]));
    let changed = false;
    for (const [id, entry] of entries) {
      const row = loaded.get(id);
      if (
        !row ||
        row.text !== entry.message.text ||
        row.expiresAt !== entry.message.expiresAt ||
        !eligible(entry)
      ) {
        entries.delete(id);
        queue.delete(entry);
        changed = true;
      }
    }
    for (const message of messages) {
      let entry = entries.get(message.id);
      if (!entry) {
        if (expired(message) || !allowed(message)) continue;
        const payload = readPayload(message.text);
        const text =
          payload && now() >= payload.roundTime ? read(message) : null;
        entry = {
          message,
          payload: payload ?? undefined,
          attempts: 0,
          state:
            text !== null
              ? { kind: "opened", text }
              : payload
                ? { kind: "locked", requestedAt: payload.requestedAt }
                : { kind: "invalid" },
        };
        entries.set(message.id, entry);
        changed = true;
      }
      if (
        entry.state.kind === "locked" ||
        (entry.retryAt !== undefined && entry.retryAt <= now())
      ) {
        if (enqueue(entry)) changed = true;
      }
    }
    if (changed || !initialized) emit();
    initialized = true;
    pump();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (lifetime.signal.aborted) return;
    let next = Infinity;
    for (const { message, payload, state, retryAt } of entries.values()) {
      if (message.expiresAt != null)
        next = Math.min(next, message.expiresAt * 1_000);
      if (state.kind === "locked" && payload)
        next = Math.min(next, payload.roundTime);
      if (retryAt !== undefined) next = Math.min(next, retryAt);
    }
    if (!Number.isFinite(next)) return;
    timer = setTimeout(
      () => refresh([...entries.values()].map((entry) => entry.message)),
      Math.max(1, Math.min(next - now(), maxTimerDelay)),
    );
  }

  return {
    scan: refresh,
    retry(id: string) {
      const entry = entries.get(id);
      if (entry?.state.kind !== "failed" && entry?.state.kind !== "locked")
        return;
      if (!enqueue(entry)) return;
      emit();
      pump();
      schedule();
    },
    stop() {
      lifetime.abort();
      clearTimeout(timer);
      queue.clear();
      entries.clear();
    },
  };
}
