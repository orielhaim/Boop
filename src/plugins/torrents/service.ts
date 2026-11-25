import { createStore } from "zustand/vanilla";
import { createPluginHost } from "@/core/plugins/host";
import type { DeliveryState, TorrentDelivery } from "@/core/plugins/delivery";
import {
  engineResponse,
  type EngineCommand,
  type EngineResult,
  type TorrentMetadata,
  type TorrentSummary,
} from "./contracts";
import { torrents } from "./descriptor";
import type { Magnet } from "./magnets";

export const resolutionPolicies = ["onTap", "automatic", "never"] as const;
type ResolutionPolicy = (typeof resolutionPolicies)[number];
type Resolution = TorrentSummary | "resolving" | "failed" | undefined;

type TorrentCache = {
  get(hash: string): TorrentMetadata | undefined;
  put(metadata: TorrentMetadata, pinned: readonly string[]): void;
  clear(pinned: readonly string[]): void;
  bytes(): number;
};

type PluginState = {
  delivery?: DeliveryState;
  initialized: boolean;
  active: boolean;
  loadFailed: boolean;
  enabled: boolean;
  policy: ResolutionPolicy;
};

export function createTorrents({
  delivery,
  newId,
  scope,
  cache,
  canAccess,
  canRunInBackground = () => false,
  readPreference,
  writePreference,
  pinned,
  pauseDownloads,
  onEligibilityChange,
}: {
  delivery: TorrentDelivery | null;
  newId(): string;
  scope: string;
  cache: TorrentCache;
  canAccess(): boolean;
  canRunInBackground?(): boolean;
  readPreference(key: string): string | null;
  writePreference(key: string, value: string): void;
  pinned(): readonly string[];
  pauseDownloads(): Promise<void>;
  onEligibilityChange(): void;
}) {
  const defaultPolicy = readPreference("torrentResolution");
  const state = createStore<PluginState>(() => ({
    initialized: false,
    active: false,
    loadFailed: false,
    enabled: readPreference("torrentsEnabled") === "true",
    policy:
      defaultPolicy === "automatic" || defaultPolicy === "never"
        ? defaultPolicy
        : "onTap",
  }));
  const entries = new Map<string, Resolution>();
  const listeners = new Map<string, Set<() => void>>();
  const resolving = new Map<
    string,
    {
      abort: AbortController;
      promise: Promise<TorrentSummary>;
      consumers: number;
    }
  >();
  let start: Promise<void> | undefined;
  let stop: Promise<void> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let commands = 0;
  const streams = new Set<string>();
  let runtimeSignal: AbortSignal | undefined;
  let deliveryRevision = 0;
  let closing = false;
  let disposed = false;
  let access = canAccess();
  const runtimeAllowed = () => {
    const snapshot = state.getState();
    return (
      !disposed &&
      !closing &&
      !!delivery &&
      snapshot.enabled &&
      !snapshot.loadFailed &&
      snapshot.delivery?.kind === "installed"
    );
  };
  const canTransfer = () => canAccess() && runtimeAllowed();
  const canContinue = () => canRunInBackground() && runtimeAllowed();

  async function execute(command: EngineCommand): Promise<EngineResult> {
    if (!delivery) throw new Error("TorrentUnavailable");
    const response = await delivery.execute(scope, JSON.stringify(command));
    if (response.length > 2 * 1024 * 1024)
      throw new Error("TorrentResponseTooLarge");
    return engineResponse.parse(JSON.parse(response));
  }

  const host = createPluginHost([
    {
      ...torrents,
      async activate(signal) {
        if (!canTransfer() || !delivery || signal.aborted)
          throw new Error("TorrentUnavailable");
        try {
          if ((await delivery.load()) !== torrents.descriptor.contractVersion) {
            throw new Error("TorrentVersion");
          }
        } catch {
          if (!signal.aborted)
            state.setState({ initialized: false, loadFailed: true });
          throw new Error("TorrentLoad");
        }
        runtimeSignal = signal;
        state.setState({
          initialized: true,
          active: !signal.aborted,
          loadFailed: false,
        });
        return async () => {
          runtimeSignal = undefined;
          await execute({ kind: "shutdown" }).catch(() => undefined);
          state.setState({ active: false });
        };
      },
    },
  ]);
  const publish = (hash: string, value: Resolution) => {
    if (!listeners.has(hash)) return;
    if (value === undefined) entries.delete(hash);
    else entries.set(hash, value);
    for (const listener of listeners.get(hash) ?? []) listener();
  };

  async function refresh(next?: DeliveryState) {
    if (!delivery || disposed) return;
    const generation = ++deliveryRevision;
    const status =
      next ??
      (await delivery
        .status()
        .catch(
          () => ({ kind: "failed", errorCode: 0 }) satisfies DeliveryState,
        ));
    if (generation !== deliveryRevision || disposed) return;
    const previous = state.getState().delivery?.kind;
    state.setState({
      delivery: status,
      ...(status.kind !== "installed" || previous !== "installed"
        ? { initialized: false, loadFailed: false }
        : {}),
    });
    if (status.kind !== "installed") await suspend();
    onEligibilityChange();
  }

  async function suspend() {
    if (stop) return stop;
    clearTimeout(idle);
    closing = true;
    for (const job of resolving.values()) job.abort.abort();
    stop = (async () => {
      try {
        await Promise.allSettled([...streams].map(closeStream));
        await host.deactivate(torrents.descriptor.id);
        await Promise.allSettled(
          [...resolving.values()].map(({ promise }) => promise),
        );
      } finally {
        closing = false;
        stop = undefined;
        if (!disposed) onEligibilityChange();
      }
    })();
    return stop;
  }

  function scheduleIdle() {
    clearTimeout(idle);
    if (!commands && !streams.size && !closing && !disposed)
      idle = setTimeout(() => void suspend(), 10_000);
  }

  async function closeStream(uri: string) {
    if (!streams.delete(uri)) return;
    try {
      await delivery?.closeStream?.(uri);
    } finally {
      scheduleIdle();
    }
  }

  async function openStream(
    requestId: string,
    size: number,
    signal: AbortSignal,
  ) {
    if (signal.aborted || !canTransfer()) return;
    clearTimeout(idle);
    commands++;
    try {
      const uri = await delivery?.openStream?.(scope, requestId, size);
      if (!uri) return;
      streams.add(uri);
      if (signal.aborted || !canTransfer()) {
        await closeStream(uri);
        return;
      }
      return { uri, size, release: () => closeStream(uri) };
    } finally {
      commands--;
      scheduleIdle();
    }
  }

  async function ensureRuntime(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!canTransfer()) throw new Error("TorrentUnavailable");
    if (!runtimeSignal || runtimeSignal.aborted) {
      start ??= host.activate(torrents.descriptor.id).finally(() => {
        start = undefined;
      });
      await start;
    }
    signal.throwIfAborted();
    if (!runtimeSignal || runtimeSignal.aborted || !canTransfer())
      throw new Error("TorrentUnavailable");
    return runtimeSignal;
  }

  async function run(
    command: Extract<EngineCommand, { kind: "resolve" | "start" }>,
    signal: AbortSignal,
    progress?: (received: number) => void,
    submitted?: () => void,
  ): Promise<EngineResult> {
    clearTimeout(idle);
    commands++;
    let lifetime: AbortSignal;
    try {
      lifetime = await ensureRuntime(signal);
    } catch (error) {
      commands--;
      throw error;
    }
    const done = Promise.withResolvers<void>();
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      done.resolve();
    };
    signal.addEventListener("abort", cancel, { once: true });
    lifetime.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted || lifetime.aborted) return { kind: "stopped" };
      const background = command.kind === "start" && canContinue();
      const authorized = () => canTransfer() || (background && canContinue());
      let result = await execute(
        command.kind === "start"
          ? { ...command, allowBackground: background }
          : command,
      );
      if (result.kind === "pending" || result.kind === "progress")
        submitted?.();
      while (
        !cancelled &&
        authorized() &&
        (result.kind === "pending" || result.kind === "progress")
      ) {
        if (result.kind === "progress") progress?.(result.received);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 400);
            }),
            done.promise,
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (!cancelled && authorized())
          result = await execute({
            kind: "poll",
            requestId: command.requestId,
          });
      }
      if (cancelled || !authorized()) return { kind: "stopped" };
      return result;
    } finally {
      signal.removeEventListener("abort", cancel);
      lifetime.removeEventListener("abort", cancel);
      await execute({
        kind: command.kind === "start" ? "stop" : "cancel",
        requestId: command.requestId,
      }).catch(() => undefined);
      commands--;
      scheduleIdle();
    }
  }

  async function resolve(magnet: Magnet, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!canTransfer() || state.getState().policy === "never")
      throw new Error("TorrentUnavailable");
    const hash = magnet.infoHash;
    const cached = cache.get(hash);
    if (cached) {
      const { metadata: _, ...summary } = cached;
      publish(hash, summary);
      return summary;
    }
    let job = resolving.get(hash);
    if (!job) {
      if (resolving.size >= 2) throw new Error("TorrentResolutionBusy");
      const abort = new AbortController();
      const promise = run(
        {
          kind: "resolve",
          requestId: newId(),
          magnet: magnet.uri,
          torrentId: hash,
        },
        abort.signal,
      )
        .then((result) => {
          if (
            abort.signal.aborted ||
            result.kind !== "resolved" ||
            result.torrentId !== hash
          ) {
            throw new Error("TorrentResolutionFailed");
          }
          const { kind: _, metadata, ...summary } = result;
          cache.put({ ...summary, metadata }, pinned());
          publish(hash, summary);
          return summary;
        })
        .catch((error: unknown) => {
          publish(hash, abort.signal.aborted ? undefined : "failed");
          throw error;
        })
        .finally(() => {
          resolving.delete(hash);
        });
      job = { abort, promise, consumers: 0 };
      resolving.set(hash, job);
      publish(hash, "resolving");
    }
    const selected = job;
    const interrupted = Promise.withResolvers<never>();
    const detach = () =>
      interrupted.reject(new Error("TorrentResolutionCancelled"));
    selected.consumers++;
    signal.addEventListener("abort", detach, { once: true });
    try {
      return await Promise.race([selected.promise, interrupted.promise]);
    } finally {
      signal.removeEventListener("abort", detach);
      if (--selected.consumers === 0) selected.abort.abort();
    }
  }

  async function enable(enabled: boolean) {
    writePreference("torrentsEnabled", String(enabled));
    state.setState({ enabled });
    onEligibilityChange();
    if (!enabled) await Promise.all([suspend(), pauseDownloads()]);
  }

  const unsubscribe = delivery?.subscribe(() => {
    void refresh();
  });
  void refresh();
  return {
    state,
    supported: !!delivery,
    descriptor: torrents.descriptor,
    match: host.match,
    canTransfer,
    canContinue,
    canStream: () => !!delivery?.openStream,
    openStream,
    refresh,
    cached: cache.get,
    readCached(hash: string) {
      if (entries.has(hash)) return;
      const cached = cache.get(hash);
      if (cached) {
        const { metadata: _, ...summary } = cached;
        publish(hash, summary);
      }
    },
    cacheBytes: cache.bytes,
    clearCache() {
      for (const job of resolving.values()) job.abort.abort();
      cache.clear(pinned());
      for (const hash of entries.keys()) publish(hash, undefined);
    },
    subscribe(hash: string, listener: () => void) {
      let set = listeners.get(hash);
      if (!set) listeners.set(hash, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) {
          listeners.delete(hash);
          entries.delete(hash);
        }
      };
    },
    snapshot(hash: string) {
      return entries.get(hash);
    },
    install: async () => {
      if (!delivery) return;
      if (state.getState().enabled) await enable(false);
      await refresh(await delivery.install());
    },
    cancelInstall: async (session: number) => {
      await delivery?.cancel(session);
      await refresh();
    },
    confirmInstall: async (session: number) => delivery?.confirm(session),
    retryLoad: async () => {
      if (!delivery || state.getState().delivery?.kind !== "installed") return;
      try {
        if ((await delivery.load()) !== torrents.descriptor.contractVersion)
          throw new Error("TorrentVersion");
        state.setState({ initialized: true, loadFailed: false });
      } catch {
        state.setState({ initialized: false, loadFailed: true });
      }
      onEligibilityChange();
    },
    async uninstall() {
      if (!delivery) return;
      await enable(false);
      await delivery.uninstall();
      await refresh();
    },
    enable,
    policy(policy: ResolutionPolicy) {
      writePreference("torrentResolution", policy);
      if (policy === "never") {
        for (const job of resolving.values()) job.abort.abort();
      }
      state.setState({ policy });
    },
    sync() {
      const next = canAccess();
      const changed = next !== access;
      access = next;
      if (!next) {
        for (const job of resolving.values()) job.abort.abort();
        if (!canContinue() && (runtimeSignal || start)) void suspend();
      } else if (changed && delivery && !disposed) void refresh();
    },
    async forget(torrentId: string) {
      if (stop) await stop;
      if (!runtimeSignal) return true;
      return (
        (await execute({ kind: "forget", torrentId }).catch(() => undefined))
          ?.kind === "stopped"
      );
    },
    resolve,
    run,
    async dispose() {
      disposed = true;
      unsubscribe?.();
      await suspend();
      await host.dispose();
      entries.clear();
      listeners.clear();
    },
  };
}

export type Torrents = ReturnType<typeof createTorrents>;
