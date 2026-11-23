import {
  canReorder,
  downloadId,
  isPending,
  type DownloadItem,
  type DownloadJob,
  type DownloadSource,
  type DownloadTarget,
} from "./types";

type Store = {
  load(): DownloadJob[];
  save(jobs: DownloadJob[]): void;
  remove(id: string): void;
  clear(): void;
};
export type TransferProgress = {
  state: string;
  received: number;
  total?: number;
};

type Transport = {
  transfer(
    target: DownloadTarget,
    progress: (event: TransferProgress) => void,
    signal: AbortSignal,
  ): Promise<string>;
  status(target: DownloadTarget): Promise<string | undefined>;
  control(
    target: DownloadTarget,
    action: "cancel" | "remove",
  ): Promise<boolean>;
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
  completed,
  concurrency = 2,
  now = Date.now,
}: {
  store: Store;
  transport: Transport;
  eligible: () => boolean;
  authorized: (source: DownloadSource) => boolean;
  completed?: (source: DownloadSource) => void;
  concurrency?: number;
  now?: () => number;
}) {
  const jobs = new Map(
    store.load().map((job): [string, DownloadItem] => [
      job.id,
      {
        ...job,
        state: job.state === "active" ? "queued" : job.state,
        speed: 0,
        verifying: false,
      },
    ]),
  );
  const listeners = new Set<() => void>();
  const running = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();
  const mutating = new Map<string, Promise<void>>();
  const compare = (a: DownloadItem, b: DownloadItem) =>
    a.order - b.order || a.createdAt - b.createdAt;
  const read = () => [...jobs.values()].sort(compare);
  function summarize(): { selected: DownloadItem | undefined; count: number } {
    const pending = snapshot.filter(isPending);
    const selected =
      pending.find(
        (job) =>
          job.state === "active" &&
          job.nativeState !== "queued" &&
          job.nativeState !== "retry_scheduled",
      ) ??
      pending.find((job) => job.state === "active") ??
      pending[0];
    return { selected, count: pending.length };
  }
  let snapshot = read();
  let indicator = summarize();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let mounted = false;
  let online = true;
  let metered = false;
  let clearing: Promise<void> | undefined;
  let closing = false;
  let reordering = false;
  let recovering: Promise<void> | undefined;
  let needsRecovery = true;
  let order = Math.max(0, ...snapshot.map((job) => job.order));
  let checking: Promise<void> | undefined;
  let reconcileAgain = false;

  const allowed = (job: DownloadSource) =>
    (job.expiresAt === null || job.expiresAt > now()) && authorized(job);

  function publish() {
    clearTimeout(progressTimer);
    progressTimer = undefined;
    snapshot = read();
    const next = summarize();
    if (indicator.selected !== next.selected || indicator.count !== next.count)
      indicator = next;
    for (const listener of listeners) listener();
  }

  function persistent({
    speed: _speed,
    verifying: _verifying,
    nativeState: _state,
    ...job
  }: DownloadItem): DownloadJob {
    return job;
  }

  function save(...items: DownloadItem[]) {
    store.save(items.map(persistent));
    for (const job of items) jobs.set(job.id, job);
    publish();
  }

  function patch(job: DownloadItem, changes: Partial<DownloadItem>) {
    save({ ...job, ...changes, changedAt: now() });
  }

  function forget(id: string) {
    store.remove(id);
    jobs.delete(id);
    publish();
  }

  function pump() {
    clearTimeout(timer);
    if (!mounted || !eligible() || clearing || closing || reordering) return;
    if (recovering) return;
    if (needsRecovery) {
      needsRecovery = false;
      recovering = (async () => {
        for (const job of read()) {
          if (closing || !mounted) break;
          if (job.state !== "paused" && job.state !== "cancelled") continue;
          const state = await transport
            .status(job.target)
            .catch(() => undefined);
          if (
            !closing &&
            mounted &&
            jobs.get(job.id) === job &&
            state &&
            inFlight.has(state)
          )
            await transport.control(job.target, "cancel").catch(() => false);
        }
      })().finally(() => {
        recovering = undefined;
        pump();
      });
      return;
    }
    const time = now();
    const hashes = new Set(
      [...running.keys()].map((id) => jobs.get(id)?.hash).filter(Boolean),
    );
    let next = Infinity;
    for (const job of read()) {
      if (running.has(job.id) || mutating.has(job.id) || !allowed(job))
        continue;
      if (!online || running.size >= (metered ? 1 : concurrency)) break;
      if (!canReorder(job) || (job.hash && hashes.has(job.hash))) continue;
      if (job.retryAt > time) {
        next = Math.min(next, job.retryAt);
        continue;
      }
      try {
        run(job);
      } catch {
        jobs.set(job.id, { ...job, state: "failed", issue: "storage" });
        publish();
        continue;
      }
      if (job.hash) hashes.add(job.hash);
    }
    for (const job of jobs.values()) {
      if (job.expiresAt !== null && job.expiresAt > time)
        next = Math.min(next, job.expiresAt);
    }
    if (Number.isFinite(next))
      timer = setTimeout(
        () => {
          reconcile();
          pump();
        },
        Math.min(2_147_483_647, Math.max(1, next - now())),
      );
  }

  function run(job: DownloadItem) {
    const admitted = {
      ...job,
      state: "active",
      nativeState: "queued",
      issue: undefined,
      changedAt: now(),
    } satisfies DownloadItem;
    store.save([persistent(admitted)]);
    jobs.set(job.id, admitted);
    const abort = new AbortController();
    let sample = { time: now(), bytes: job.received };
    const done = Promise.resolve()
      .then(async () => {
        if (abort.signal.aborted) return;
        let phase: string;
        try {
          phase = await transport.transfer(
            job.target,
            ({ state, received, total }) => {
              const current = jobs.get(job.id);
              if (!current || abort.signal.aborted) return;
              let speed = current.speed;
              const time = now();
              const transferring = state === "downloading";
              if (!transferring || received < sample.bytes) {
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
          );
        } catch {
          phase = "interrupted";
        }
        if (abort.signal.aborted || !mounted) return;
        const current = jobs.get(job.id);
        if (!current) return;
        if (!allowed(current)) {
          await transport.control(current.target, "remove").catch(() => false);
          if (jobs.get(job.id) === current) forget(job.id);
        } else if (phase === "ready") {
          patch(current, {
            state: "completed",
            speed: 0,
            verifying: false,
            received: current.total ?? current.received,
          });
          completed?.(current);
        } else {
          if (phase === "storage_blocked")
            await transport.control(job.target, "cancel").catch(() => false);
          if (abort.signal.aborted || !mounted || jobs.get(job.id) !== current)
            return;
          const transient = phase === "interrupted";
          const issue =
            phase === "storage_blocked"
              ? "storage"
              : transient
                ? "interrupted"
                : [
                      "unavailable",
                      "remote",
                      "policy_blocked",
                      "removed",
                      "completed_unretained",
                      "previously_acquired_unavailable",
                      "cleaned_by_setting",
                    ].includes(phase)
                  ? "unavailable"
                  : "transfer";
          const retries = current.retries + 1;
          const retry = transient && retries <= 3;
          patch(current, {
            state: retry ? "waiting" : "failed",
            retries,
            retryAt: retry ? now() + 2_000 * 2 ** (retries - 1) : 0,
            issue,
            speed: 0,
            verifying: false,
          });
        }
      })
      .catch(() => {
        const current = jobs.get(job.id);
        if (
          !mounted ||
          !current ||
          current.state !== "active" ||
          abort.signal.aborted
        )
          return;
        jobs.set(job.id, {
          ...current,
          state: "failed",
          issue: "storage",
          speed: 0,
          verifying: false,
        });
        publish();
      })
      .finally(() => {
        running.delete(job.id);
        pump();
      });
    running.set(job.id, { abort, done });
    publish();
  }

  function control(
    id: string,
    action: "paused" | "cancelled" | "remove",
  ): Promise<void> {
    if (!mounted || closing) return Promise.resolve();
    const previous = mutating.get(id);
    if (previous) return previous.then(() => control(id, action));
    const operation = Promise.resolve()
      .then(async () => {
        const job = jobs.get(id);
        if (!job || !mounted || closing) return;
        const active = running.get(id);
        if (action !== "remove")
          patch(job, { state: action, speed: 0, verifying: false });
        active?.abort.abort();
        await active?.done;
        if (action === "remove") {
          await transport.control(job.target, "remove");
          if (mounted) forget(id);
        } else if (!clearing && active && mounted && allowed(job)) {
          const state = await transport
            .status(job.target)
            .catch(() => undefined);
          const current = jobs.get(id);
          if (state === "ready" && current && mounted && !closing) {
            patch(current, {
              state: "completed",
              received: current.total ?? current.received,
            });
            completed?.(current);
          }
        }
      })
      .finally(() => {
        mutating.delete(id);
        pump();
      });
    mutating.set(id, operation);
    return operation;
  }

  function resume(id: string) {
    if (!mounted || closing || clearing) return;
    const pending = mutating.get(id);
    if (pending) {
      void pending.then(() => resume(id)).catch(() => undefined);
      return;
    }
    const job = jobs.get(id);
    if (
      !job ||
      !allowed(job) ||
      !["paused", "failed", "cancelled"].includes(job.state)
    )
      return;
    patch(job, { state: "queued", issue: undefined, retries: 0, retryAt: 0 });
    pump();
  }

  function reconcile() {
    if (checking) {
      reconcileAgain = true;
      return checking;
    }
    checking = (async () => {
      if (!mounted || closing || !eligible()) return;
      for (const job of read()) {
        if (!mounted || closing || !eligible()) break;
        if (mutating.has(job.id)) continue;
        if (!allowed(job)) {
          await control(job.id, "remove").catch(() => undefined);
          continue;
        }
        if (job.state !== "completed") continue;
        const state = await transport.status(job.target).catch(() => undefined);
        if (mounted && jobs.get(job.id) === job && state && state !== "ready")
          forget(job.id);
      }
    })().finally(() => {
      checking = undefined;
      if (reconcileAgain) {
        reconcileAgain = false;
        void reconcile();
      }
    });
    return checking;
  }

  return {
    snapshot: () => snapshot,
    indicator: () => indicator,
    get: (id: string) => jobs.get(id),
    accountReady() {
      needsRecovery ||= closing;
      closing = false;
      void reconcile().then(pump);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      mounted = true;
      needsRecovery = true;
      pump();
      void reconcile();
      return () => {
        mounted = false;
        clearTimeout(timer);
        clearTimeout(progressTimer);
      };
    },
    sync: pump,
    setReordering(value: boolean) {
      reordering = value;
      if (!value) pump();
    },
    reconcile,
    invalidate(group: string, message: string) {
      for (const job of jobs.values())
        if (job.target[0] === group && job.target[1] === message)
          void control(job.id, "remove").catch(() => undefined);
    },
    network(connected: boolean, cellular: boolean) {
      online = connected;
      metered = cellular;
      pump();
    },
    enqueue(source: DownloadSource) {
      if (!mounted || clearing || closing || !eligible() || !allowed(source))
        return;
      const id = downloadId(source.target);
      if (mutating.has(id)) return;
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
    resume,
    pause: (id: string) => control(id, "paused"),
    cancel: (id: string) => control(id, "cancelled"),
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
      closing = true;
      const active = [...running.entries()];
      for (const [id, run] of active) {
        const job = jobs.get(id);
        run.abort.abort();
        if (mounted && job?.state === "active")
          jobs.set(id, { ...job, state: "queued", speed: 0, verifying: false });
      }
      if (mounted && active.length) publish();
      await Promise.allSettled([
        ...active.map(([, run]) => run.done),
        ...mutating.values(),
        recovering,
        checking,
        clearing,
      ]);
    },
    clear(clearNative: () => Promise<void>) {
      if (clearing) return clearing;
      clearing = Promise.resolve()
        .then(async () => {
          await Promise.all(
            read()
              .filter(isPending)
              .map((job) => control(job.id, "cancelled")),
          );
          if (!mounted || closing) return;
          await clearNative();
          if (!mounted) return;
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
