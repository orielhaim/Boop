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
};

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
          entry.state = {
            kind: "failed",
            requestedAt: payload.requestedAt,
            error: reason instanceof TimeLockError ? reason.code : "decryption",
          };
        })
        .finally(() => {
          running--;
          emit();
          pump();
        });
    }
  }

  function enqueue(entry: Entry) {
    const { payload } = entry;
    if (!payload || !eligible(entry)) return;
    if (now() < Math.max(payload.requestedAt, payload.roundTime)) return;
    entry.state = { kind: "opening", requestedAt: payload.requestedAt };
    queue.add(entry);
  }

  return {
    scan(messages: readonly Message[]) {
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
        if (entries.has(message.id) || expired(message) || !allowed(message))
          continue;
        const text = read(message);
        const payload = text === null ? readPayload(message.text) : null;
        const entry: Entry = {
          message,
          payload: payload ?? undefined,
          state:
            text !== null
              ? { kind: "opened", text }
              : payload
                ? { kind: "locked", requestedAt: payload.requestedAt }
                : { kind: "invalid" },
        };
        entries.set(message.id, entry);
        enqueue(entry);
        changed = true;
      }
      if (changed || !initialized) emit();
      initialized = true;
      pump();
    },
    retry(id: string) {
      const entry = entries.get(id);
      if (entry?.state.kind !== "failed" && entry?.state.kind !== "locked")
        return;
      enqueue(entry);
      emit();
      pump();
    },
    stop() {
      lifetime.abort();
      queue.clear();
      entries.clear();
    },
  };
}
