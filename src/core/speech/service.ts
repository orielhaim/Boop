import { acceptedAttachments } from "@/core/marmot/message-projection";
import { getPowerStateAsync, BatteryState } from "expo-battery";
import { getNetworkStateAsync, NetworkStateType } from "expo-network";
import { Linking, Platform } from "react-native";
import { marmot, type MarmotMessage } from "@/core/marmot/native";
import type { Database } from "@/db";
import { preference, setPreference } from "@/db/queries";
import { speechStore } from "@/db/speech";
import { createTranscriptEncryption } from "./encryption";
import { createSpeechEngine, speechError } from "./engine";
import { createSpeechScheduler, priority } from "./scheduler";
import {
  attachmentId,
  preferenceSchema,
  sourceSchema,
  type SpeechJob,
  type SpeechPreferences,
  type SpeechSource,
} from "./types";

export function speechSource(
  group: string,
  row: MarmotMessage,
  item: ReturnType<typeof acceptedAttachments>[number],
  account: string,
): SpeechSource | undefined {
  if (
    !row.sourceId ||
    row.deleted ||
    row.invalidationStatus ||
    !item.voice ||
    !item.type.startsWith("audio/")
  )
    return undefined;
  return {
    target: [group, row.id, row.sourceId, item.index],
    hash: item.plaintextHash ?? null,
    sender: row.sender,
    incoming: row.sender !== account,
    expiresAt: row.expiresAt == null ? null : row.expiresAt * 1000,
    duration: item.duration ?? null,
    sentAt: row.sentAt,
  };
}

export function createVoiceTranscription({
  db,
  account,
  appLocale,
  active,
  available,
  audioBusy,
  blocked,
  hidden,
}: {
  db: Database;
  account: string;
  appLocale: () => string;
  active: () => boolean;
  available: () => boolean;
  audioBusy: () => boolean;
  blocked: (sender: string) => boolean;
  hidden: (group: string, id: string) => boolean;
}) {
  const key = "speech.preferences";
  const read = () => {
    try {
      return preferenceSchema.parse(JSON.parse(preference(db, key) ?? "{}"));
    } catch {
      return preferenceSchema.parse({});
    }
  };
  let preferences = read();
  let clearAt = Number(preference(db, "speech.clearAt") ?? 0);
  let charging = false;
  let lowPower = true;
  let mounted = false;
  let recording = false;
  let preparing = false;
  let powerRevision = 0;
  let revision = 0;
  let admissionGeneration = 0;
  let lastSweep: Promise<void> | undefined;
  let waitingCheck: Promise<void> | undefined;
  let attemptedModel: string | undefined;
  let modelOperation: Promise<void> | undefined;
  let accountClosing = false;
  let clearing = false;
  let resourceTimer: ReturnType<typeof setTimeout> | undefined;
  let discovering: Promise<void> | undefined;
  const sessionStarted = Date.now() / 1000;
  const notes = sourceSchema.array().max(24);
  const listeners = new Set<() => void>();
  const sourceListeners = new Map<string, Set<() => void>>();
  const admissions = new Map<string, Promise<void>>();
  let languageRequest: { token: string; source: SpeechSource } | undefined;
  let wasAccessible = false;
  const notify = (key?: string) => {
    revision += 1;
    for (const listener of listeners) listener();
    const scoped = key ? [sourceListeners.get(key)] : sourceListeners.values();
    for (const group of scoped) for (const listener of group ?? []) listener();
  };
  const access = () =>
    mounted && !accountClosing && !clearing && active() && available();
  const canRun = (automatic: boolean) =>
    !recording &&
    !audioBusy() &&
    !preparing &&
    !resourceTimer &&
    (!automatic ||
      (preferences.mode === "automatic" &&
        (!preferences.charging || charging) &&
        (!preferences.respectLowPower || !lowPower)));
  const engine = createSpeechEngine();
  const valid = async (source: SpeechSource) => {
    const [group, id] = source.target;
    if (
      blocked(source.sender) ||
      hidden(group, id) ||
      (source.expiresAt !== null && source.expiresAt <= Date.now())
    )
      return false;
    const bytes = await marmot.retainedAttachmentBytes(...source.target);
    if (
      bytes == null ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > 100 * 1024 * 1024
    )
      return false;
    const details = await marmot.groupAccess(group, true);
    return (
      details.membership === "member" &&
      !details.pendingInvitation &&
      !details.pendingLeave &&
      !details.unrecoverable &&
      (details.kind === "group" ||
        (details.kind === "direct" &&
          details.members.every((member) => !blocked(member))))
    );
  };
  const encryption = createTranscriptEncryption(account);
  const scheduler = createSpeechScheduler({
    account,
    store: speechStore(db, account),
    encryption,
    backend: engine,
    preferences: () => preferences,
    canAccess: access,
    canRun,
    valid,
    open: (source) => marmot.openAttachment(...source.target),
    duration: async (lease) =>
      (await marmot.inspectMediaFile(lease.path, false, false)).duration,
    async release(lease) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await marmot.releaseAttachment(lease);
          return;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
    },
    errorCode(error) {
      const code = speechError(error);
      return Platform.OS === "android" && code === "permission-denied"
        ? "unsupported"
        : code;
    },
    notify,
  });
  function reconcile(all = false) {
    if (all)
      return (lastSweep ?? Promise.resolve()).then(() =>
        scheduler.reconcile(true),
      );
    lastSweep ??= scheduler.reconcile().finally(() => {
      lastSweep = undefined;
    });
    return lastSweep;
  }
  function sync() {
    const accessible = access();
    if (wasAccessible && !accessible) {
      admissionGeneration += 1;
    }
    const restored = !wasAccessible && accessible;
    wasAccessible = accessible;
    scheduler.sync();
    if (restored && preferences.mode !== "off") void resumeWaiting();
  }
  function resumeWaiting() {
    waitingCheck ??= scheduler.resumeWaiting().finally(() => {
      waitingCheck = undefined;
    });
    return waitingCheck;
  }
  async function power() {
    const version = ++powerRevision;
    const state = await getPowerStateAsync().catch(() => undefined);
    if (!state || version !== powerRevision || !mounted) return;
    charging =
      state.batteryState === BatteryState.CHARGING ||
      state.batteryState === BatteryState.FULL;
    lowPower = state.lowPowerMode;
    sync();
  }
  async function install(
    locale: string,
    progress?: (fraction: number) => void,
    automatic = false,
  ) {
    if (
      !access() ||
      !canRun(automatic) ||
      preferences.mode === "off" ||
      modelOperation
    )
      return;
    if (preferences.modelDownloads === "wifi") {
      const network = await getNetworkStateAsync();
      if (!network.isConnected || network.type !== NetworkStateType.WIFI)
        throw new Error("SpeechModelNeedsWiFi");
    }
    if (!access() || !canRun(automatic) || modelOperation) return;
    const mode = preferences.recognitionMode;
    preparing = true;
    sync();
    modelOperation = (async () => {
      await scheduler.drained();
      if (!access() || preferences.mode === "off" || audioBusy() || recording)
        return;
      await engine.install(locale, mode, progress);
    })();
    try {
      await modelOperation;
    } finally {
      preparing = false;
      modelOperation = undefined;
      sync();
      void resumeWaiting();
    }
  }
  function automaticEligible(source: SpeechSource, rank: number) {
    return (
      preferences.mode === "automatic" &&
      (source.incoming ? preferences.incoming : preferences.outgoing) &&
      (rank === priority.download || preferences.downloaded) &&
      (rank === priority.download || source.sentAt * 1000 > clearAt) &&
      source.duration !== null &&
      source.duration <= preferences.maxDuration
    );
  }
  async function admit(source: SpeechSource, rank: number, override?: string) {
    const manual = rank === priority.request;
    if (!access() || preferences.mode === "off") return;
    if (!manual && preferences.mode === "automatic" && scheduler.has(source)) {
      scheduler.promote(source, rank);
      return;
    }
    if (!manual && !automaticEligible(source, rank)) return;
    const epoch = admissionGeneration;
    const current = preferences;
    const key = JSON.stringify([attachmentId(source), override, rank]);
    const existing = admissions.get(key);
    if (existing) return existing;
    if (!manual && admissions.size >= 12) return;
    const live = () =>
      epoch === admissionGeneration && access() && preferences === current;
    const admission = (async () => {
      if (!(await valid(source)) || !live()) return;
      const config = await engine.configuration(current, appLocale(), override);
      if (!live()) return;
      if (!config) {
        scheduler.unsupported(source);
        return;
      }
      scheduler.enqueue(source, config, rank);
      if (
        !manual &&
        Platform.OS === "ios" &&
        config.engine === "analyzer" &&
        current.modelDownloads === "wifi" &&
        attemptedModel === undefined &&
        canRun(true) &&
        (await engine.status(config.locale, config.mode)) === "supported" &&
        live()
      ) {
        attemptedModel = config.locale;
        await install(config.locale, undefined, true).catch(() => {
          attemptedModel = undefined;
        });
      }
    })().finally(() => {
      if (admissions.get(key) === admission) admissions.delete(key);
    });
    admissions.set(key, admission);
    return admission;
  }
  function outgoing(source: SpeechSource, sentAt: number) {
    return admit(
      source,
      sentAt >= sessionStarted && sentAt * 1000 > clearAt
        ? priority.download
        : priority.retained,
    );
  }
  function discoverRetained() {
    if (
      !access() ||
      preferences.mode !== "automatic" ||
      (!preferences.outgoing &&
        !(preferences.incoming && preferences.downloaded)) ||
      discovering
    )
      return;
    const epoch = admissionGeneration;
    const since = Math.floor(
      preferences.downloaded ? Date.now() / 1000 - 86_400 : sessionStarted,
    );
    discovering = (async () => {
      const candidates = notes.parse(
        await marmot.recentVoiceNotes(
          account,
          since,
          !(preferences.incoming && preferences.downloaded),
        ),
      );
      for (const source of candidates) {
        if (epoch !== admissionGeneration || !access()) break;
        if (source.incoming) await admit(source, priority.retained);
        else await outgoing(source, source.sentAt);
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        discovering = undefined;
      });
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => revision,
    getPreferences: () => preferences,
    setPreferences(update: Partial<SpeechPreferences>) {
      const next = preferenceSchema.parse({ ...preferences, ...update });
      setPreference(db, key, JSON.stringify(next));
      preferences = next;
      admissionGeneration += 1;
      attemptedModel = undefined;
      scheduler.updateAutomaticScope(
        (source) =>
          next.mode === "automatic" &&
          (source.incoming ? next.incoming : next.outgoing) &&
          source.duration !== null &&
          source.duration <= next.maxDuration,
      );
      sync();
      discoverRetained();
      notify();
    },
    start() {
      mounted = true;
      sync();
      void power();
      const interval = setInterval(() => {
        if (access()) {
          void reconcile();
          discoverRetained();
          if (preferences.mode !== "off" && canRun(false)) void resumeWaiting();
        }
      }, 30_000);
      return () => {
        mounted = false;
        languageRequest = undefined;
        admissionGeneration += 1;
        clearInterval(interval);
        if (resourceTimer) clearTimeout(resourceTimer);
        resourceTimer = undefined;
        sync();
      };
    },
    sync,
    power,
    reconcile,
    accountReady() {
      accountClosing = false;
      sync();
      discoverRetained();
    },
    async beforeAccountClose() {
      accountClosing = true;
      languageRequest = undefined;
      sync();
      await scheduler.drained();
    },
    memoryWarning() {
      if (resourceTimer) clearTimeout(resourceTimer);
      resourceTimer = setTimeout(() => {
        resourceTimer = undefined;
        sync();
      }, 60_000);
      sync();
    },
    setRecording(value: boolean) {
      if (recording === value) return;
      recording = value;
      sync();
    },
    view: scheduler.view,
    canPresent: access,
    subscribeSource(source: SpeechSource | undefined, listener: () => void) {
      if (!source) return () => {};
      const id = attachmentId(source);
      const group = sourceListeners.get(id) ?? new Set();
      group.add(listener);
      sourceListeners.set(id, group);
      return () => {
        group.delete(listener);
        if (!group.size) sourceListeners.delete(id);
      };
    },
    refresh(source: SpeechSource) {
      if (scheduler.has(source)) void scheduler.refresh(source);
    },
    availableLocally(source: SpeechSource, rank: number) {
      void admit(source, rank).catch(() => undefined);
    },
    outgoing(source: SpeechSource, sentAt: number) {
      void outgoing(source, sentAt).catch(() => undefined);
    },
    async request(source: SpeechSource, override?: string) {
      if (!access() || preferences.mode === "off") return;
      if (!override && scheduler.hasFinished(source))
        await scheduler.refresh(source);
      else await admit(source, priority.request, override);
    },
    languageRequest(source: SpeechSource) {
      const token = String(++revision);
      languageRequest = { source, token };
      return token;
    },
    async chooseLanguage(token: string, locale: string) {
      if (languageRequest?.token !== token || !access()) return false;
      await admit(languageRequest.source, priority.request, locale);
      languageRequest = undefined;
      return true;
    },
    async retry(job: SpeechJob) {
      if (!access() || preferences.mode === "off") return;
      if (job.status === "waitingForPermission") {
        const permission = await engine.requestPermission();
        if (permission === "settings" && access()) await Linking.openSettings();
        if (permission !== "granted") return;
      }
      if (access()) scheduler.retry(job);
    },
    cancel: scheduler.cancel,
    clearSource: scheduler.clearSource,
    invalidateMessage: scheduler.invalidateMessage,
    stats: scheduler.stats,
    async clear() {
      if (clearing) return;
      admissionGeneration += 1;
      languageRequest = undefined;
      clearAt = Date.now();
      setPreference(db, "speech.clearAt", String(clearAt));
      clearing = true;
      sync();
      try {
        await scheduler.clear();
        await encryption.clear();
        await engine.clearTemporary();
      } finally {
        clearing = false;
        sync();
      }
    },
    clearTemporary: engine.clearTemporary,
    capabilities: engine.capabilities,
    models: () => engine.models(preferences.recognitionMode),
    modelStatus: (locale: string) =>
      engine.status(locale, preferences.recognitionMode),
    install,
    reserve: engine.reserve,
    resumeModels: resumeWaiting,
  };
}
