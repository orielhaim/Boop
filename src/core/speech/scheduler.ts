import {
  attachmentId,
  jobId,
  type SpeechConfig,
  type SpeechJob,
  type SpeechPreferences,
  type SpeechSource,
  type StoredTranscript,
  validateTranscript,
} from "./types";

export const priority = {
  request: 5,
  playing: 4,
  visible: 3,
  download: 2,
  retained: 1,
};
type JobStatus = SpeechJob["status"];
type Lease = { lease: string; path: string; type: string };
type Backend = {
  authorized(config: SpeechConfig): Promise<boolean>;
  status(locale: string, mode: SpeechConfig["mode"]): Promise<string>;
  transcribe(
    config: SpeechConfig,
    path: string,
    signal: AbortSignal,
    progress: (fraction: number) => void,
  ): Promise<unknown>;
  release(): void;
};
export type SpeechView = {
  job?: SpeechJob;
  transcript?: StoredTranscript;
  progress?: number;
  unsupported?: boolean;
};
const emptyView: SpeechView = {};
const interruptible = new Set<JobStatus>([
  "queued",
  "preparing",
  "transcribing",
]);
const finished = (job: SpeechJob) =>
  job.status === "completed" || job.status === "empty";
const transient = new Set([
  "busy",
  "interrupted",
  "service",
  "start-timeout",
  "network",
]);
const retention = 30 * 86_400_000;
const maxJobs = 256;
const maxAutomaticPending = 32;
const maxCacheBytes = 16 * 1024 * 1024;

export function createSpeechScheduler({
  account,
  store,
  encryption,
  backend,
  preferences,
  canAccess,
  canRun,
  valid,
  open,
  duration,
  release,
  errorCode,
  notify,
  now = Date.now,
}: {
  account: string;
  store: {
    load(): SpeechJob[];
    save(job: SpeechJob, sealed?: string | null): void;
    read(id: string): string | null | undefined;
    remove(id: string): void;
    clear(): void;
    bytes(): number;
  };
  encryption: {
    seal(id: string, value: StoredTranscript): Promise<string>;
    open(id: string, value: string): Promise<StoredTranscript>;
  };
  backend: Backend;
  preferences(): SpeechPreferences;
  canAccess(): boolean;
  canRun(automatic: boolean): boolean;
  valid(source: SpeechSource): Promise<boolean>;
  open(source: SpeechSource): Promise<Lease | null | undefined>;
  duration?(lease: Lease): Promise<number | null | undefined>;
  release(lease: string): Promise<void>;
  errorCode(error: unknown): string;
  notify(attachment?: string): void;
  now?: () => number;
}) {
  const jobs = new Map<string, SpeechJob>();
  const views = new Map<string, SpeechView>();
  const decoded = new Map<string, StoredTranscript>();
  const verified = new Set<string>();
  const refreshing = new Map<string, Promise<void>>();
  let running: { job: SpeechJob; abort: AbortController } | undefined;
  let worker: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let retryStoreAt = 0;
  let access = false;
  let initialized = false;
  let sweepOffset = 0;

  function readyJobs() {
    return [...jobs.values()].filter((job) => interruptible.has(job.status));
  }
  function recompute(key: string, progress?: number) {
    const rows = [...jobs.values()].filter(
      (job) => attachmentId(job.source) === key,
    );
    rows.sort((a, b) => b.updated - a.updated);
    const job = rows.find((row) => row.id === running?.job.id) ?? rows[0];
    const result =
      rows.filter(finished).find((row) => decoded.get(row.id)?.text.trim()) ??
      rows.find((row) => decoded.has(row.id));
    const transcript = result && decoded.get(result.id);
    const current = views.get(key);
    if (
      current?.job === job &&
      current?.transcript === transcript &&
      current?.progress === progress
    )
      return;
    views.set(key, { job, transcript, progress });
    notify(key);
  }
  function write(job: SpeechJob, sealed?: string) {
    store.save(job, sealed);
    jobs.set(job.id, job);
    scheduleExpiry();
    recompute(attachmentId(job.source));
    return job;
  }
  function update(
    job: SpeechJob,
    status: JobStatus,
    fields?: Partial<SpeechJob>,
  ) {
    return write({ ...job, ...fields, status, updated: now() });
  }
  function remove(job: SpeechJob) {
    if (running?.job.id === job.id) running.abort.abort();
    decoded.delete(job.id);
    store.remove(job.id);
    jobs.delete(job.id);
    scheduleExpiry();
    recompute(attachmentId(job.source));
  }
  function scheduleExpiry() {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (!canAccess()) return;
    const next = Math.min(
      ...[...jobs.values()].map((job) =>
        Math.min(job.source.expiresAt ?? Infinity, job.updated + retention),
      ),
    );
    if (!Number.isFinite(next)) return;
    expiryTimer = setTimeout(
      () => {
        if (canAccess()) trim();
        scheduleExpiry();
      },
      Math.max(1, Math.min(2_147_483_647, next - now())),
    );
  }
  function trim() {
    const expired = [...jobs.values()].filter(
      ({ source, updated }) =>
        (source.expiresAt !== null && source.expiresAt <= now()) ||
        updated <= now() - retention,
    );
    for (const job of expired) remove(job);
    if (jobs.size < maxJobs) return;
    const evictable = [...jobs.values()]
      .filter(
        (job) => job.id !== running?.job.id && !interruptible.has(job.status),
      )
      .sort((a, b) => a.updated - b.updated);
    for (const job of evictable.slice(0, jobs.size - maxJobs + 1)) remove(job);
  }
  function enabled() {
    return access && canAccess() && preferences().mode !== "off";
  }
  function refresh(source: SpeechSource) {
    if (!enabled()) return Promise.resolve();
    const key = attachmentId(source);
    const existing = refreshing.get(key);
    if (existing) return existing;
    const epoch = generation;
    const live = () => generation === epoch && enabled();
    const refresh = (async () => {
      if (!(await valid(source))) {
        if (live()) invalidate(source);
        return;
      }
      if (!live()) return;
      verified.add(key);
      const rows = [...jobs.values()]
        .filter((row) => attachmentId(row.source) === key && finished(row))
        .sort((a, b) => b.updated - a.updated);
      for (const row of rows) {
        if (decoded.get(row.id)?.text.trim()) break;
        if (decoded.has(row.id)) continue;
        const sealed = store.read(row.id);
        if (!sealed) continue;
        const transcript = await encryption
          .open(row.id, sealed)
          .catch(() => undefined);
        if (!live() || jobs.get(row.id) !== row || !verified.has(key)) return;
        if (!transcript) continue;
        remember(row.id, transcript);
        if (transcript.text.trim()) break;
      }
      recompute(key);
    })()
      .catch(() => undefined)
      .finally(() => {
        if (refreshing.get(key) === refresh) refreshing.delete(key);
      });
    refreshing.set(key, refresh);
    return refresh;
  }
  function remember(id: string, transcript: StoredTranscript) {
    decoded.set(id, transcript);
    if (decoded.size <= 16) return;
    const oldest = decoded.keys().next().value;
    if (oldest === undefined) return;
    decoded.delete(oldest);
    const row = jobs.get(oldest);
    if (row) recompute(attachmentId(row.source));
  }
  function invalidate(source: SpeechSource) {
    const key = attachmentId(source);
    verified.delete(key);
    for (const job of [...jobs.values()])
      if (attachmentId(job.source) === key) remove(job);
  }
  async function process(job: SpeechJob, abort: AbortController) {
    const { signal } = abort;
    const epoch = generation;
    const automatic = job.priority < priority.request;
    const live = () =>
      !signal.aborted &&
      generation === epoch &&
      enabled() &&
      canRun(automatic) &&
      jobs.has(job.id);
    let lease: Lease | null | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      if (!live()) return;
      const expiresIn =
        job.source.expiresAt === null ? Infinity : job.source.expiresAt - now();
      const timeout = Math.min(12 * 60_000, expiresIn);
      deadline = setTimeout(
        () => {
          if (expiresIn <= timeout) invalidate(job.source);
          else {
            timedOut = true;
            abort.abort();
          }
        },
        Math.max(0, timeout),
      );
      job = update(job, "preparing");
      if (!(await valid(job.source))) {
        if (live()) invalidate(job.source);
        return;
      }
      if (!live()) return;
      const { locale, mode } = job.config;
      const model = await backend.status(locale, mode);
      if (!live()) return;
      if (model === "unsupported") {
        update(job, "unsupported");
        return;
      }
      if (model !== "installed") {
        update(job, "waitingForModel");
        return;
      }
      const authorized = await backend.authorized(job.config);
      if (!live()) return;
      if (!authorized) {
        update(job, "waitingForPermission");
        return;
      }
      lease = await open(job.source);
      if (!live()) return;
      if (!lease) {
        update(job, "waitingForMedia");
        return;
      }
      if (!lease.type.startsWith("audio/"))
        throw new Error("Invalid speech media type");
      const seconds = automatic && duration ? await duration(lease) : undefined;
      if (!live()) return;
      if (
        automatic &&
        duration &&
        (seconds == null || seconds > preferences().maxDuration)
      ) {
        update(job, "cancelled", { error: "duration-limit" });
        return;
      }
      job = update(job, "transcribing");
      const transcript = validateTranscript(
        await backend.transcribe(job.config, lease.path, signal, (progress) => {
          if (live() && Number.isFinite(progress))
            recompute(
              attachmentId(job.source),
              Math.round(progress * 100) / 100,
            );
        }),
      );
      if (!live()) return;
      const sealed = await encryption.seal(job.id, transcript);
      if (!live()) return;
      if (!(await valid(job.source))) {
        if (live()) invalidate(job.source);
        return;
      }
      if (!live()) return;
      verified.add(attachmentId(job.source));
      write(
        {
          ...job,
          status: transcript.text.trim() ? "completed" : "empty",
          updated: now(),
        },
        sealed,
      );
      remember(job.id, transcript);
      recompute(attachmentId(job.source));
      let bytes = store.bytes();
      const older = [...jobs.values()]
        .filter((row) => finished(row) && row.id !== job.id)
        .sort((a, b) => a.updated - b.updated);
      for (const row of older) {
        if (bytes <= maxCacheBytes) break;
        bytes -= store.read(row.id)?.length ?? 0;
        remove(row);
      }
    } catch (error) {
      if (!live()) return;
      const code = errorCode(error);
      const attempts = job.attempts + 1;
      if (transient.has(code) && attempts <= 2) {
        update(job, "queued", {
          attempts,
          readyAt: now() + 2 ** attempts * 1000,
          error: code,
        });
      } else {
        const status =
          code === "permission-denied"
            ? "waitingForPermission"
            : code === "locale-unavailable"
              ? "waitingForModel"
              : code === "unsupported"
                ? "unsupported"
                : code === "cancelled"
                  ? "cancelled"
                  : "failed";
        update(job, status, { attempts, error: code });
      }
    } finally {
      if (deadline) clearTimeout(deadline);
      try {
        if (lease) await release(lease.lease);
      } finally {
        const current = jobs.get(job.id);
        if (
          current &&
          (current.status === "preparing" || current.status === "transcribing")
        )
          update(
            current,
            timedOut ? "failed" : "queued",
            timedOut ? { error: "start-timeout" } : undefined,
          );
      }
    }
  }
  function kick() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (worker || !enabled()) return;
    if (retryStoreAt > now()) {
      timer = setTimeout(kick, retryStoreAt - now());
      return;
    }
    const eligible = readyJobs().filter((job) =>
      canRun(job.priority < priority.request),
    );
    const job = eligible
      .filter((job) => job.readyAt <= now())
      .sort((a, b) => b.priority - a.priority || a.updated - b.updated)[0];
    if (!job) {
      const next = Math.min(...eligible.map((row) => row.readyAt));
      if (Number.isFinite(next))
        timer = setTimeout(kick, Math.max(1, next - now()));
      return;
    }
    const abort = new AbortController();
    running = { job, abort };
    worker = Promise.resolve()
      .then(() => process(job, abort))
      .catch(() => {
        retryStoreAt = now() + 30_000;
      })
      .finally(() => {
        running = undefined;
        worker = undefined;
        if (!enabled() || !canRun(false)) backend.release();
        recompute(attachmentId(job.source));
        kick();
      });
  }
  return {
    drained: () => worker ?? Promise.resolve(),
    view(source: SpeechSource): SpeechView {
      return enabled() &&
        (source.expiresAt === null || source.expiresAt > now())
        ? (views.get(attachmentId(source)) ?? emptyView)
        : emptyView;
    },
    has(source: SpeechSource) {
      const key = attachmentId(source);
      return [...jobs.values()].some((job) => attachmentId(job.source) === key);
    },
    hasFinished(source: SpeechSource) {
      const key = attachmentId(source);
      return [...jobs.values()].some(
        (job) => finished(job) && attachmentId(job.source) === key,
      );
    },
    promote(source: SpeechSource, rank: number) {
      const key = attachmentId(source);
      const next = [...jobs.values()].find(
        (job) =>
          job.id !== running?.job.id &&
          attachmentId(job.source) === key &&
          (interruptible.has(job.status) || job.status === "waitingForMedia"),
      );
      if (next?.status === "waitingForMedia")
        update(next, "queued", {
          priority: Math.max(next.priority, rank),
          readyAt: now(),
        });
      else if (next && next.priority < rank) write({ ...next, priority: rank });
      kick();
    },
    refresh,
    invalidate,
    async reconcile(all = false) {
      if (!canAccess()) return;
      trim();
      const epoch = generation;
      const sources = [
        ...new Map(
          [...jobs.values()].map((job) => [
            attachmentId(job.source),
            job.source,
          ]),
        ).values(),
      ];
      const start = all || sweepOffset >= sources.length ? 0 : sweepOffset;
      const batch = all ? sources : sources.slice(start, start + 20);
      sweepOffset = start + batch.length;
      for (const source of batch) {
        if (epoch !== generation || !canAccess()) break;
        if (
          !(await valid(source).catch(() => true)) &&
          epoch === generation &&
          canAccess()
        )
          invalidate(source);
      }
    },
    enqueue(source: SpeechSource, config: SpeechConfig, rank: number) {
      if (!enabled()) return;
      const id = jobId(account, source, config);
      const previous = jobs.get(id);
      if (previous && finished(previous)) {
        void refresh(source);
        return;
      }
      if (running?.job.id === id) return;
      if (!previous) trim();
      if (
        previous &&
        rank < priority.request &&
        !interruptible.has(previous.status)
      )
        return;
      if (
        !previous &&
        rank < priority.request &&
        readyJobs().length >= maxAutomaticPending
      )
        return;
      if (!previous && jobs.size >= maxJobs) return;
      write({
        id,
        source,
        config,
        status: "queued",
        priority: Math.max(previous?.priority ?? 0, rank),
        attempts: previous?.status === "queued" ? previous.attempts : 0,
        readyAt: previous?.status === "queued" ? previous.readyAt : now(),
        updated: now(),
      });
      kick();
    },
    unsupported(source: SpeechSource) {
      const key = attachmentId(source);
      views.set(key, {
        ...views.get(key),
        unsupported: true,
      });
      notify(key);
    },
    retry(job: SpeechJob) {
      const current = jobs.get(job.id);
      if (
        enabled() &&
        current &&
        running?.job.id !== job.id &&
        !finished(current)
      ) {
        update(current, "queued", {
          priority: priority.request,
          attempts: 0,
          readyAt: now(),
          error: undefined,
        });
        kick();
      }
    },
    updateAutomaticScope(allowed: (source: SpeechSource) => boolean) {
      for (const job of jobs.values()) {
        if (
          job.priority === priority.request ||
          finished(job) ||
          job.status === "cancelled" ||
          allowed(job.source)
        )
          continue;
        if (running?.job.id === job.id) running.abort.abort();
        update(job, "cancelled");
      }
    },
    async resumeWaiting() {
      if (!enabled()) return;
      const epoch = generation;
      const checks = new Map<string, Promise<boolean>>();
      for (const job of jobs.values()) {
        const { config } = job;
        const kind = job.status;
        if (kind !== "waitingForModel" && kind !== "waitingForPermission")
          continue;
        const key = JSON.stringify([
          kind,
          config.locale,
          config.mode,
          config.engine,
        ]);
        const check =
          checks.get(key) ??
          (kind === "waitingForPermission"
            ? backend.authorized(config)
            : backend
                .status(config.locale, config.mode)
                .then((status) => status === "installed"));
        checks.set(key, check);
        const ready = await check.catch(() => false);
        if (epoch !== generation || !enabled()) return;
        if (ready && jobs.get(job.id) === job)
          update(job, "queued", { readyAt: now() });
      }
      kick();
    },
    cancel(job: SpeechJob) {
      const current = jobs.get(job.id);
      if (!current || finished(current)) return;
      if (running?.job.id === job.id) running.abort.abort();
      update(current, "cancelled");
    },
    clearSource(source: SpeechSource) {
      const key = attachmentId(source);
      for (const job of jobs.values()) {
        if (attachmentId(job.source) !== key) continue;
        if (running?.job.id === job.id) running.abort.abort();
        decoded.delete(job.id);
        update(job, "cancelled");
      }
    },
    invalidateMessage(group: string, id: string) {
      for (const job of [...jobs.values()]) {
        if (job.source.target[0] === group && job.source.target[1] === id)
          invalidate(job.source);
      }
    },
    sync() {
      if (!initialized && canAccess()) {
        initialized = true;
        for (const job of store.load()) {
          if (interruptible.has(job.status) && job.status !== "queued")
            update(job, "queued", { readyAt: now() });
          else {
            jobs.set(job.id, job);
            recompute(attachmentId(job.source));
          }
        }
      }
      const available = canAccess() && preferences().mode !== "off";
      if (access && !available) {
        generation += 1;
        decoded.clear();
        verified.clear();
        refreshing.clear();
        views.clear();
      }
      if (access !== available) {
        access = available;
        notify();
      }
      if (
        running &&
        (!available || !canRun(running.job.priority < priority.request))
      )
        running.abort.abort();
      if (!worker && (!available || !canRun(false))) backend.release();
      if (canAccess() && preferences().mode === "off") {
        for (const job of [...jobs.values()])
          if (!finished(job) && job.status !== "cancelled")
            update(job, "cancelled");
      }
      scheduleExpiry();
      kick();
    },
    async clear() {
      generation += 1;
      running?.abort.abort();
      store.clear();
      jobs.clear();
      scheduleExpiry();
      views.clear();
      decoded.clear();
      verified.clear();
      refreshing.clear();
      notify();
      await worker;
    },
    stats() {
      const all = [...jobs.values()];
      return {
        bytes: store.bytes(),
        saved: all.filter(finished).length,
        pending: all.filter(
          ({ status }) =>
            interruptible.has(status) || status.startsWith("waiting"),
        ).length,
      };
    },
  };
}
