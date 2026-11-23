import { selectDownloads } from "./scheduler";
import type {
  DownloadControl,
  DownloadFile,
  DownloadTransport,
} from "./transport";
import {
  canReorder,
  isPending,
  sourceId,
  type DownloadItem,
  type DownloadJob,
  type DownloadSource,
} from "./types";

export type { TransferProgress } from "./transport";

type Store = {
  load(): DownloadJob[];
  save(jobs: DownloadJob[]): void;
  remove(id: string): void;
  clear(): void;
};
const inFlight = new Set([
  "queued",
  "downloading",
  "verifying_ciphertext",
  "decrypting",
  "verifying_plaintext",
  "retry_scheduled",
]);

export function createDownloadManager({
  store,
  transport,
  eligible,
  authorized,
  available = () => true,
  completed,
  concurrency = 2,
  now = Date.now,
}: {
  store: Store;
  transport: DownloadTransport;
  eligible: () => boolean;
  available?: (source: DownloadSource) => boolean;
  authorized: (source: DownloadSource) => boolean;
  completed?: (source: DownloadSource) => void;
  concurrency?: number;
  now?: () => number;
}) {
  const jobs = new Map<string, DownloadItem>(
    store
      .load()
      .map((job) => [
        job.id,
        { ...job, speed: 0, verifying: false } satisfies DownloadItem,
      ]),
  );
  const listeners = new Set<() => void>();
  const running = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();
  const commands = new Map<string, Promise<void>>();
  const read = () =>
    [...jobs.values()].sort(
      (a, b) => a.order - b.order || a.createdAt - b.createdAt,
    );
  let snapshot = read();
  let layout = snapshot;
  let indicator = summarize();
  let order = snapshot.reduce(
    (maximum, job) => Math.max(maximum, job.order),
    0,
  );
  let phase: "stopped" | "recovering" | "ready" = "stopped";
  let marmotClosing = false;
  let discovery: Promise<void> | undefined;
  let recovery: Promise<void> | undefined;
  let clearing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let online = true;
  let metered = false;
  let reordering = false;
  const allowed = (job: DownloadSource) =>
    (job.expiresAt === null || job.expiresAt > now()) && authorized(job);

  const usable = (job: DownloadSource) =>
    !(job.kind === "marmot" && marmotClosing) && available(job);
  const runningSession = () => phase !== "stopped";

  function summarize(): { selected: DownloadItem | undefined; count: number } {
    const pending = snapshot.filter(isPending);
    const active = pending.filter((job) => job.state === "active");
    return {
      selected:
        active.find(
          (job) => job.nativeState === "downloading" || job.verifying,
        ) ??
        active[0] ??
        pending[0],
      count: pending.length,
    };
  }

  function publish() {
    clearTimeout(progressTimer);
    progressTimer = undefined;
    snapshot = read();
    if (
      layout.length !== snapshot.length ||
      snapshot.some((job, index) => {
        const before = layout[index];
        return (
          before.id !== job.id ||
          before.state !== job.state ||
          before.intent !== job.intent
        );
      })
    )
      layout = snapshot;
    const next = summarize();
    if (indicator.selected !== next.selected || indicator.count !== next.count)
      indicator = next;
    for (const listener of listeners) listener();
  }

  function save(...items: DownloadItem[]) {
    store.save(
      items.map(
        ({
          speed: _speed,
          verifying: _verifying,
          nativeState: _native,
          ...row
        }) => row,
      ),
    );
    for (const item of items) jobs.set(item.id, item);
    publish();
  }
  function patch(
    job: DownloadItem,
    changes: Partial<
      Pick<
        DownloadItem,
        | "state"
        | "received"
        | "total"
        | "issue"
        | "intent"
        | "nativeState"
        | "speed"
        | "verifying"
        | "retryAt"
        | "retries"
      >
    >,
  ) {
    save({ ...job, ...changes, changedAt: now() });
  }
  function forget(id: string) {
    store.remove(id);
    jobs.delete(id);
    publish();
  }
  function finish(job: DownloadItem) {
    patch(job, {
      state: "completed",
      intent: undefined,
      issue: undefined,
      speed: 0,
      verifying: false,
      received: job.total ?? job.received,
    });
    completed?.(job);
  }

  function pump() {
    clearTimeout(timer);
    if (!eligible() || clearing || phase === "stopped") return;
    if (phase === "recovering") {
      if (!recovery) void reconcile();
      return;
    }
    if (reordering) return;
    const capacity = online
      ? Math.max(0, (metered ? 1 : concurrency) - running.size)
      : 0;
    const { ready, wakeAt } = selectDownloads(
      read().filter((job) => allowed(job) && usable(job)),
      new Set([...running.keys(), ...commands.keys()]),
      capacity,
      now(),
    );
    for (const job of ready) {
      try {
        run(job);
      } catch {
        jobs.set(job.id, { ...job, state: "failed", issue: "storage" });
        publish();
      }
    }
    const deadline = read().reduce(
      (minimum, job) =>
        job.expiresAt !== null && job.expiresAt > now()
          ? Math.min(minimum, job.expiresAt)
          : minimum,
      wakeAt,
    );
    if (Number.isFinite(deadline))
      timer = setTimeout(
        () => void reconcile(),
        Math.min(2_147_483_647, Math.max(1, deadline - now())),
      );
  }

  function run(job: DownloadItem, attach = false) {
    const abort = new AbortController();
    if (job.state !== "active")
      patch(job, { state: "active", issue: undefined, nativeState: "queued" });
    let sample = { time: now(), bytes: job.received };
    const done = Promise.resolve()
      .then(async () => {
        if (abort.signal.aborted) return;
        let result: string;
        try {
          result = await transport.transfer(
            job,
            ({ state, received, total }) => {
              const current = jobs.get(job.id);
              if (abort.signal.aborted || !current) return;
              let speed = current.speed;
              const time = now();
              if (state !== "downloading" || received < sample.bytes) {
                speed = 0;
                sample = { time, bytes: received };
              } else if (time - sample.time >= 600) {
                const rate =
                  ((received - sample.bytes) * 1000) / (time - sample.time);
                speed = speed ? speed * 0.65 + rate * 0.35 : rate;
                sample = { time, bytes: received };
              }
              jobs.set(job.id, {
                ...current,
                received,
                total: total ?? current.total,
                speed,
                nativeState: state,
                verifying:
                  state.startsWith("verifying") || state === "decrypting",
              });
              progressTimer ??= setTimeout(publish, 200);
            },
            abort.signal,
            attach,
          );
        } catch {
          result = "interrupted";
        }
        const current = jobs.get(job.id);
        if (
          !current ||
          current.intent ||
          abort.signal.aborted ||
          phase === "stopped"
        )
          return;
        if (!allowed(current)) {
          patch(current, { intent: "remove" });
          await applyControl(job.id, "remove");
        } else if (result === "ready") finish(current);
        else {
          if (result === "storage_blocked")
            await transport.control(current, "cancel").catch(() => undefined);
          if (jobs.get(job.id) !== current || abort.signal.aborted) return;
          const interrupted =
            result === "interrupted" || result === "cancelled";
          const unavailable = [
            "unavailable",
            "remote",
            "policy_blocked",
            "removed",
            "completed_unretained",
            "previously_acquired_unavailable",
            "cleaned_by_setting",
          ].includes(result);
          const retries = current.retries + 1;
          const retry = interrupted && retries <= 3;
          patch(current, {
            state: retry ? "waiting" : "failed",
            retryAt: retry ? now() + 2_000 * 2 ** (retries - 1) : 0,
            retries,
            speed: 0,
            verifying: false,
            issue:
              result === "storage_blocked"
                ? "storage"
                : unavailable
                  ? "unavailable"
                  : interrupted
                    ? "interrupted"
                    : "transfer",
          });
        }
      })
      .catch(() => {
        const current = jobs.get(job.id);
        if (current && !current.intent && !abort.signal.aborted) {
          jobs.set(job.id, {
            ...current,
            state: "failed",
            issue: "storage",
            speed: 0,
            verifying: false,
          });
          publish();
        }
      })
      .finally(() => {
        running.delete(job.id);
        pump();
      });
    running.set(job.id, { abort, done });
  }

  async function applyControl(
    id: string,
    action: DownloadControl,
    wait = false,
  ) {
    const job = jobs.get(id);
    if (!job) return;
    const run = running.get(id);
    if (job.kind === "marmot" && run && wait) {
      run.abort.abort();
      await run.done;
      if (action === "remove") await transport.control(job, action);
      else {
        const status = await transport.status(job);
        if (status && inFlight.has(status))
          await transport.control(job, action);
      }
    } else {
      await transport.control(job, action);
      run?.abort.abort();
      if (wait) await run?.done;
    }
    const current = jobs.get(id);
    if (!current) return;
    if (action === "remove") forget(id);
    else if ((await transport.status(current)) === "ready" && allowed(current))
      finish(current);
    else
      patch(current, {
        state: action === "pause" ? "paused" : "cancelled",
        intent: undefined,
        speed: 0,
        verifying: false,
      });
  }

  function control(id: string, action: DownloadControl): Promise<void> {
    if (phase === "stopped") return Promise.resolve();
    const previous = commands.get(id);
    if (previous) return previous.then(() => control(id, action));
    const command = Promise.resolve()
      .then(async () => {
        const job = jobs.get(id);
        if (!job || phase === "stopped" || !usable(job)) return;
        patch(job, { intent: action });
        await discovery;
        if (!runningSession()) return;
        await applyControl(id, action, true);
      })
      .finally(() => {
        commands.delete(id);
        pump();
      });
    commands.set(id, command);
    return command;
  }

  function reconcile(): Promise<void> {
    if (recovery) return recovery;
    if (!eligible() || phase === "stopped" || clearing)
      return Promise.resolve();
    const discover = phase === "recovering";
    if (discover && transport.recover)
      discovery = Promise.resolve()
        .then(() => transport.recover?.(read()))
        .finally(() => {
          discovery = undefined;
        });
    recovery = (async () => {
      if (discover) await discovery;
      for (const job of read()) {
        if (!eligible() || !runningSession()) return;
        if (!usable(job) || commands.has(job.id)) continue;
        if (!allowed(job)) {
          await control(job.id, "remove").catch(() => undefined);
        } else if (job.intent) {
          await control(job.id, job.intent).catch(() => undefined);
        } else if (
          !running.has(job.id) &&
          (discover || job.state === "active" || job.state === "completed")
        ) {
          const state = await transport.status(job).catch(() => undefined);
          if (
            !runningSession() ||
            !usable(job) ||
            jobs.get(job.id) !== job ||
            commands.has(job.id)
          )
            continue;
          if (!state) continue;
          if (state === "ready" && isPending(job)) finish(job);
          else if (job.state === "completed" && state !== "ready")
            forget(job.id);
          else if (
            inFlight.has(state) &&
            (job.state === "active" || canReorder(job))
          )
            run(job, true);
          else if (job.state === "active") {
            patch(job, {
              state:
                state === "paused" && job.kind === "http" ? "paused" : "queued",
              speed: 0,
              verifying: false,
            });
          } else if (
            (job.state === "cancelled" || job.state === "paused") &&
            inFlight.has(state)
          ) {
            await control(
              job.id,
              job.state === "paused" ? "pause" : "cancel",
            ).catch(() => undefined);
          }
        }
      }
      if (phase === "recovering") phase = "ready";
    })()
      .catch(() => undefined)
      .finally(() => {
        recovery = undefined;
        if (phase === "recovering") {
          clearTimeout(timer);
          timer = setTimeout(pump, 3_000);
        } else pump();
      });
    return recovery;
  }

  function resume(id: string) {
    if (phase === "stopped" || clearing) return;
    const previous = commands.get(id);
    if (previous) {
      void previous.then(() => resume(id)).catch(() => undefined);
      return;
    }
    const job = jobs.get(id);
    if (
      !job ||
      job.intent ||
      !allowed(job) ||
      !["paused", "failed", "cancelled"].includes(job.state)
    )
      return;
    patch(job, { state: "queued", issue: undefined, retries: 0, retryAt: 0 });
    pump();
  }

  return {
    snapshot: () => snapshot,
    layout: () => layout,
    indicator: () => indicator,
    get: (id: string) => jobs.get(id),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      phase = "recovering";
      pump();
      return () => {
        phase = "stopped";
        clearTimeout(timer);
        clearTimeout(progressTimer);
        for (const run of running.values()) run.abort.abort();
      };
    },
    accountReady() {
      marmotClosing = false;
      void reconcile();
    },
    sync: pump,
    reconcile,
    setReordering(value: boolean) {
      reordering = value;
      if (!value) pump();
    },
    invalidate(group: string, message: string) {
      for (const job of jobs.values())
        if (
          job.kind === "marmot" &&
          job.target[0] === group &&
          job.target[1] === message
        )
          void control(job.id, "remove").catch(() => undefined);
    },
    network(connected: boolean, cellular: boolean) {
      online = connected;
      metered = cellular;
      pump();
    },
    enqueue(source: DownloadSource) {
      if (phase === "stopped" || clearing || !eligible() || !allowed(source))
        return;
      const id = sourceId(source);
      if (commands.has(id)) return;
      const old = jobs.get(id);
      if (old) {
        if (!isPending(old) && old.state !== "completed") resume(id);
        return;
      }
      save({
        ...source,
        id,
        state: "queued",
        received: 0,
        speed: 0,
        verifying: false,
        retries: 0,
        retryAt: 0,
        order: ++order,
        createdAt: now(),
        changedAt: now(),
      });
      pump();
    },
    async open(id: string, consume: (file: DownloadFile) => Promise<void>) {
      const job = jobs.get(id);
      if (
        !job ||
        job.state !== "completed" ||
        job.intent ||
        !eligible() ||
        !usable(job) ||
        !allowed(job)
      )
        return;
      await transport.open?.(job, async (file) => {
        if (eligible() && jobs.get(id) === job && allowed(job))
          await consume(file);
      });
    },
    resume,
    pause: (id: string) => control(id, "pause"),
    cancel: (id: string) => control(id, "cancel"),
    remove: (id: string) => control(id, "remove"),
    reorder(id: string, before: string | undefined) {
      const pending = read().filter(canReorder);
      const from = pending.findIndex((item) => item.id === id);
      if (from < 0 || id === before) return;
      const positions = pending.map((item) => item.order);
      const [item] = pending.splice(from, 1);
      const to =
        before === undefined
          ? pending.length
          : pending.findIndex((row) => row.id === before);
      if (to < 0) return;
      pending.splice(to, 0, item);
      save(
        ...pending.flatMap((row, i) =>
          row.order === positions[i] ? [] : [{ ...row, order: positions[i] }],
        ),
      );
      pump();
    },
    async beforeAccountClose() {
      marmotClosing = true;
      const active = [...running].filter(
        ([id]) => jobs.get(id)?.kind === "marmot",
      );
      for (const [, run] of active) run.abort.abort();
      await Promise.allSettled([
        ...active.map(([, run]) => run.done),
        ...[...commands]
          .filter(([id]) => jobs.get(id)?.kind === "marmot")
          .map(([, command]) => command),
        recovery,
        clearing,
      ]);
    },
    clear(clearNative: () => Promise<void>) {
      if (clearing) return clearing;
      clearing = Promise.resolve()
        .then(async () => {
          await Promise.all(
            read().map((job) =>
              control(job.id, job.kind === "http" ? "remove" : "cancel"),
            ),
          );
          if (phase === "stopped") return;
          await clearNative();
          store.clear();
          jobs.clear();
          publish();
        })
        .finally(() => {
          clearing = undefined;
          pump();
        });
      return clearing;
    },
  };
}
export type DownloadManager = ReturnType<typeof createDownloadManager>;
