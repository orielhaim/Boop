import {
  addBatteryStateListener,
  addLowPowerModeListener,
  BatteryState,
  getBatteryStateAsync,
} from "expo-battery";
import {
  addNetworkStateListener,
  getNetworkStateAsync,
  NetworkStateType,
} from "expo-network";
import { createMediaSdk } from "@/core/media";
import { createNativeLinkPreviews } from "@/core/messaging/native-link-previews";
import { File } from "expo-file-system";
import { uploadAvatar } from "@/core/avatars/blossom";
import { createProfileEditor } from "@/core/avatars/editor";
import { createAvatars } from "@/core/avatars/service";
import { asc } from "drizzle-orm";
import { getLocales } from "expo-localization";
import { addDatabaseChangeListener } from "expo-sqlite";
import { useEffect } from "react";
import { AppState } from "react-native";
import { createCallSignalingService } from "@/core/calling/signaling-service";
import { createNip05Lookup } from "@/core/nostr/nip05-lookup";
import { createPublicMetadata } from "@/core/nostr/public-metadata";
import { createRelayService } from "@/core/nostr/relay-service";
import { createCallController } from "@/core/calling/controller";
import { attachGroupCallLifecycle } from "@/core/calling/group-call-lifecycle";
import { callTone } from "@/core/calling/native-audio";
import {
  attachSystemPresentation,
  openTelecomAudio,
} from "@/core/calling/system-calling";
import {
  initializeCallingRuntime,
  randomCallId,
  trysteroMedia,
} from "@/core/calling/trystero";
import { initializeIdentity, initializeMarmotIdentity } from "@/core/identity";
import { createChatPreferences } from "@/core/marmot/chat-preferences";
import { createMarmotSession } from "@/core/marmot/account-session";
import { createMarmotViewport } from "@/core/marmot/viewport";
import { marmot } from "@/core/marmot/native";
import { toNpub } from "@/core/identity/keys";
import { messagingMetric } from "@/core/messaging/diagnostics";
import { configuredRelays, inboxIntentKey } from "@/core/nostr/config";
import { createPrivacy } from "@/core/privacy";
import { type AppLock, createAppLock } from "@/core/security/app-lock";
import { authenticateApp, protectAppWindow } from "@/core/security/native-auth";
import { loadTranslationEngine } from "@/core/translation/native";
import { initializeTranslationPreferences } from "@/core/translation/preferences";
import { createTranslationService } from "@/core/translation/service";
import { createVoiceTranscription } from "@/core/speech/service";
import { openDatabase } from "@/db";
import {
  callById,
  contactByKey,
  preference,
  saveCallRecord,
  setPreference,
  updateContactPreferences,
} from "@/db/queries";
import { seedRelays } from "@/db/relays";
import { relaySettings } from "@/db/schema";
import { createDerivedTranslations } from "@/db/translations";
import { purgeExpiredOpenedMessages } from "@/db/open-later";
import { i18n, preferredLanguage, resolveLanguage } from "@/i18n";
import { readLanguagePreference } from "@/i18n/preference";
import { useLocal } from "./local-context";

async function start() {
  const started = performance.now();
  const db = await openDatabase();
  try {
    const language = readLanguagePreference(db);
    await i18n.changeLanguage(
      preferredLanguage(
        language,
        language === "auto" ? getLocales()[0]?.languageCode : undefined,
      ),
    );
    const identityStarted = performance.now();
    const lock = createAppLock({
      read: (key) => preference(db, key),
      write: (key, value) => setPreference(db, key, value),
      startActive: AppState.currentState === "active",
      authenticate: authenticateApp,
      protect: protectAppWindow,
    });
    appLock = lock;
    const loaded = await initializeIdentity(db);
    if (!loaded) {
      return {
        status: "welcome" as const,
        db,
        lock,
        theme: preference(db, "theme"),
        haptics: preference(db, "haptics") !== "off",
      };
    }
    const { identity, signer, fresh } = loaded;
    messagingMetric("identity ready", {
      ms: performance.now() - identityStarted,
    });
    initializeTranslationPreferences(db, resolveLanguage(i18n.language));
    purgeExpiredOpenedMessages(db);
    seedRelays(db, fresh);
    const chatPreferences = createChatPreferences(db);
    const privacy = createPrivacy(db, identity.publicKey);
    const mediaSdk = createMediaSdk(db, signer);
    const messagingStarted = performance.now();
    const relays = createRelayService({
      readState: (key) => preference(db, key),
      writeState: (key, value) => setPreference(db, key, value),
      signer,
    });
    const callSignaling = createCallSignalingService({
      signer,
      relays,
      isBlocked: privacy.isBlocked,
      canReceiveCall: privacy.canReceiveCall,
    });
    const active = () =>
      AppState.currentState === "active" && !lock.getState().locked;
    const publicMetadata = createPublicMetadata(
      relays,
      identity.publicKey,
      active,
    );
    const nip05 = createNip05Lookup(active);
    const { disk, localDirectory } = mediaSdk.profileFiles;
    const avatars = createAvatars(
      db,
      identity.publicKey,
      privacy,
      publicMetadata,
      disk,
      mediaSdk.profileDownload,
      mediaSdk.profileMirrors,
    );
    const profileEditor = createProfileEditor(
      db,
      identity.publicKey,
      avatars,
      disk,
      (filename, signal, wide) =>
        uploadAvatar(
          mediaSdk,
          new File(localDirectory, filename),
          signal,
          wide,
        ),
      publicMetadata,
    );
    let beforeAccountClose: (() => Promise<void>) | undefined;
    const marmotSession = createMarmotSession(
      async (configuration, mediaOrigin) => {
        const state = await initializeMarmotIdentity(
          db,
          identity.publicKey,
          configuration,
          mediaOrigin,
        );
        try {
          for (const key of privacy.blockedKeys())
            await marmot.setBlocked(key, true);
        } catch (failure) {
          await marmot.closeAccount();
          throw failure;
        }
        return state;
      },
      () => beforeAccountClose?.() ?? Promise.resolve(),
    );
    let previousBlocks = new Set(privacy.blockedKeys());
    privacy.subscribe(() => {
      const current = new Set(privacy.blockedKeys());
      const changes = [
        ...[...previousBlocks]
          .filter((key) => !current.has(key))
          .map((key) => ({ key, blocked: false })),
        ...[...current]
          .filter((key) => !previousBlocks.has(key))
          .map((key) => ({ key, blocked: true })),
      ];
      previousBlocks = current;
      if (changes.length)
        void marmotSession
          .ready()
          .then(async () => {
            for (const { key, blocked } of changes) {
              if (privacy.isBlocked(key) === blocked)
                await marmot.setBlocked(key, blocked);
            }
          })
          .catch(() => undefined);
    });
    privacy.subscribe(avatars.invalidate);
    let profileRelays = publicMetadata.profileRelayKey();
    relays.subscribe(() => {
      const next = publicMetadata.profileRelayKey();
      if (next === profileRelays) return;
      profileRelays = next;
      avatars.refreshRelays();
    });
    messagingMetric("runtime initialized", {
      ms: performance.now() - messagingStarted,
    });
    const marmotViewport = createMarmotViewport(
      identity.publicKey,
      () => {
        const state = lock.getState();
        return (
          state.active &&
          !state.locked &&
          AppState.currentState === "active" &&
          chatPreferences.enabled()
        );
      },
      privacy.isBlocked,
    );
    const previews = createNativeLinkPreviews(
      db,
      privacy,
      mediaSdk,
      marmotViewport,
    );
    lock.subscribe(previews.revalidate);
    chatPreferences.subscribe(previews.revalidate);
    const media = trysteroMedia(
      signer,
      {
        get(peerKey) {
          const row = contactByKey(db, peerKey).get();
          return row ? (row.allowIncomingVideo ? "always" : "ask") : "unknown";
        },
        allow(peerKey) {
          return (
            updateContactPreferences(db, peerKey, {
              allowIncomingVideo: true,
            }).changes === 1
          );
        },
      },
      ({ invite, peerKey, signal, onRouting }) => {
        const privateMode = lock.getState().enabled;
        const contact = contactByKey(db, peerKey).get();
        return openTelecomAudio({
          id: invite.callId,
          name: contact?.name ?? `${toNpub(peerKey).slice(0, 15)}…`,
          avatar: () => avatars.resolve(peerKey),
          subscribeAvatar: (listener) => avatars.subscribe(peerKey, listener),
          incoming: invite.recipientKey === identity.publicKey,
          privateMode,
          signal,
          onRouting,
        });
      },
      callSignaling.send,
      privacy.isBlocked,
    );
    const calling = createCallController({
      localKey: identity.publicKey,
      isBlocked: privacy.isBlocked,
      async authorizeGroup(group, peers) {
        if (!chatPreferences.enabled() || peers.some(privacy.isBlocked))
          return false;
        await marmotSession.ready();
        const details = await marmot.groupDetails(group);
        if (
          details.membership !== "member" ||
          details.kind !== "group" ||
          details.pendingInvitation ||
          details.unrecoverable ||
          details.lifecycle !== "stable"
        )
          return false;
        const current = new Set(details.members.map((member) => member.id));
        return (
          current.has(identity.publicKey) &&
          peers.every((peer) => current.has(peer) && !privacy.isBlocked(peer))
        );
      },
      randomId: randomCallId,
      openMedia: media.open,
      prepareMedia: initializeCallingRuntime,
      prepareInvite: (invite, signal) => {
        void callSignaling
          .prepareRoute(invite.callId, invite.recipientKey)
          .catch(() => undefined);
        return media.prepare(invite, signal);
      },
      send: callSignaling.send,
      tone: callTone,
      record: (entry) => {
        db.transaction(() => {
          saveCallRecord(db, entry);
          if (
            entry.direction === "outgoing" &&
            entry.answeredAt !== null &&
            (entry.outcome === "completed" ||
              entry.outcome === "remote-disconnected")
          )
            privacy.noteCompletedCall(entry.peerKey);
        });
      },
      hasRecord: (id, invitationId) => {
        const entry = callById(db, id);
        return invitationId
          ? entry?.invitationIds.includes(invitationId) === true
          : !!entry;
      },
    });
    privacy.subscribeBlock((key) => {
      calling.peerBlocked(key);
    });
    callSignaling.subscribe((message) => {
      if (message.type === "call.rtc") media.receive(message);
      else calling.receive(message);
    });
    const nativeOpen = attachSystemPresentation(calling, {
      privateMode: () => lock.getState().enabled,
      subscribe: lock.subscribe,
    });
    const speech = createVoiceTranscription({
      db,
      account: identity.publicKey,
      appLocale: () => i18n.language,
      active,
      available: () =>
        chatPreferences.enabled() && marmotSession.status() === "ready",
      audioBusy: () => {
        const call = calling.store.getState().call;
        return Boolean(call && call.phase !== "ended");
      },
      blocked: privacy.isBlocked,
      hidden: (group, id) => chatPreferences.hidden(group).includes(id),
    });
    beforeAccountClose = speech.beforeAccountClose;
    appLock = lock;
    messagingMetric("local startup ready", { ms: performance.now() - started });
    return {
      status: "ready" as const,
      db,
      translation: createTranslationService(
        createDerivedTranslations(db, marmotViewport.incomingText),
        loadTranslationEngine,
      ),
      identity,
      speech,
      avatars,
      previews,
      mediaSdk,
      profileEditor,
      publicMetadata,
      nip05,
      privacy,
      chatPreferences,
      marmotSession,
      marmotViewport,
      relays,
      callSignaling,
      calling,
      nativeOpen,
      lock,
      theme: preference(db, "theme"),
      haptics: preference(db, "haptics") !== "off",
    };
  } catch (error) {
    db.$client.closeSync();
    throw error;
  }
}

let appLock: AppLock | undefined;
let initialization: ReturnType<typeof start> | undefined;

export function acceptsLiveLink() {
  const state = appLock?.getState();
  return state && (!state.enabled || (state.active && !state.locked));
}
export function initializeLocal() {
  initialization ??= start().catch((error) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}

export function finishOnboarding(db: Awaited<ReturnType<typeof openDatabase>>) {
  db.$client.closeSync();
  initialization = undefined;
}

export function LocalSessionLifecycle() {
  const {
    db,
    identity,
    relays,
    callSignaling,
    calling,
    lock,
    avatars,
    marmotSession,
    chatPreferences,
    mediaSdk,
    profileEditor,
    publicMetadata,
    speech,
    privacy,
  } = useLocal();
  useEffect(() => {
    const stopSpeech = speech.start();
    const unsubscribeSpeechCall = calling.store.subscribe(speech.sync);
    const unsubscribeSpeechPrivacy = privacy.subscribe(
      () => void speech.reconcile(),
    );
    const lowPower = addLowPowerModeListener(speech.power);
    const memory = AppState.addEventListener(
      "memoryWarning",
      speech.memoryWarning,
    );
    const stopGroupCalls = attachGroupCallLifecycle({
      calling,
      localKey: identity.publicKey,
      ready: marmotSession.ready,
      client: marmot,
    });
    const databasePath =
      db.$client.getFirstSync<{ file: string }>(
        "SELECT file FROM pragma_database_list WHERE name = 'main'",
      )?.file ?? db.$client.databasePath;
    let checkAfterPrompt: ReturnType<typeof setTimeout> | undefined;
    const readRelays = () =>
      db.select().from(relaySettings).orderBy(asc(relaySettings.url)).all();
    let rows = readRelays();
    let intent = preference(db, inboxIntentKey);
    let configuration = configuredRelays(rows, intent);
    const attachmentOrigin = () =>
      mediaSdk.configured("attachment")[0]?.origin ?? null;
    let mediaOrigin = attachmentOrigin();
    let queued = false;
    let mounted = true;
    let relaysChanged = false;
    let conditionsRevision = 0;
    function updateBackupConditions() {
      const revision = ++conditionsRevision;
      if (!chatPreferences.enabled()) return;
      void marmotSession
        .ready()
        .then(async () => {
          if (!mounted || revision !== conditionsRevision) return;
          const eligible = AppState.currentState === "active";
          if (!eligible) {
            await marmot.backupConditions(false, false);
            return;
          }
          const [network, battery] = await Promise.all([
            getNetworkStateAsync(),
            getBatteryStateAsync(),
          ]);
          if (
            mounted &&
            revision === conditionsRevision &&
            AppState.currentState === "active"
          ) {
            await marmot.backupConditions(
              network.type === NetworkStateType.WIFI &&
                network.isConnected === true,
              battery === BatteryState.CHARGING ||
                battery === BatteryState.FULL,
            );
          }
        })
        .catch(() => undefined);
    }
    function connectMessaging() {
      if (!chatPreferences.enabled())
        void marmotSession.stop().catch(() => undefined);
      else if (AppState.currentState === "active")
        void marmotSession.start(configuration, mediaOrigin);
    }
    function connect() {
      callSignaling.start();
      relays.start(configuration);
      connectMessaging();
    }
    const dbChanges = addDatabaseChangeListener(
      ({ databaseFilePath, tableName }) => {
        if (databaseFilePath !== databasePath) return;
        if (tableName === "contacts") queueMicrotask(avatars.invalidate);
        if (tableName !== "relay_settings" && tableName !== "settings") return;
        relaysChanged ||= tableName === "relay_settings";
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (!mounted) return;
          const nextIntent = preference(db, inboxIntentKey);
          if (!relaysChanged && intent === nextIntent) return;
          if (relaysChanged) rows = readRelays();
          relaysChanged = false;
          intent = nextIntent;
          configuration = configuredRelays(rows, intent);
          if (AppState.currentState === "active") connect();
        });
      },
    );
    function updateUnlocks() {
      avatars.setActive(
        AppState.currentState === "active" && !lock.getState().locked,
      );
    }
    function background() {
      calling.setForeground(false);
      if (calling.isRequestingMicrophone()) return;
      callSignaling.stop();
      relays.stop();
    }
    function catchUpMessaging() {
      if (chatPreferences.enabled())
        void marmotSession
          .ready()
          .then(() => {
            if (mounted && AppState.currentState === "active")
              return marmot.catchUp();
          })
          .catch(() => undefined);
    }
    const update = (state: typeof AppState.currentState) => {
      speech.sync();
      if (checkAfterPrompt) clearTimeout(checkAfterPrompt);
      avatars.setActive(state === "active" && !lock.getState().locked);
      if (state === "active") {
        calling.setForeground(true);
        connect();
        catchUpMessaging();
      } else if (state === "background" && !lock.getState().authenticating) {
        background();
      }
      updateBackupConditions();
    };
    const unsubscribeLock = lock.subscribe(() => {
      speech.sync();
      updateUnlocks();
      if (
        lock.getState().authenticating ||
        AppState.currentState !== "background"
      )
        return;
      if (checkAfterPrompt) clearTimeout(checkAfterPrompt);
      checkAfterPrompt = setTimeout(() => {
        if (
          AppState.currentState === "background" &&
          !lock.getState().authenticating
        )
          background();
      }, 800);
    });
    update(AppState.currentState);
    const subscription = AppState.addEventListener("change", update);
    let chatsEnabled = chatPreferences.enabled();
    const unsubscribeChats = chatPreferences.subscribe(() => {
      const next = chatPreferences.enabled();
      if (next === chatsEnabled) return;
      chatsEnabled = next;
      speech.sync();
      connectMessaging();
    });
    const unsubscribeMedia = mediaSdk.subscribe(() => {
      const next = attachmentOrigin();
      if (next === mediaOrigin) return;
      mediaOrigin = next;
      connectMessaging();
    });
    let profileTimer: ReturnType<typeof setTimeout> | undefined;
    let profileRetryDelay = 0;
    let profileRevision = profileEditor.getSnapshot().editRevision;
    let publishingProfile = false;

    function profileEligible() {
      return (
        mounted &&
        AppState.currentState === "active" &&
        !lock.getState().locked &&
        Boolean(publicMetadata.profileRelayKey()) &&
        (preference(db, "profile.initialBackup") !== identity.publicKey ||
          marmotSession.status() === "ready") &&
        Boolean(profileEditor.draft())
      );
    }

    function scheduleProfilePublish() {
      if (!profileEligible()) {
        clearTimeout(profileTimer);
        profileTimer = undefined;
        return;
      }
      if (profileTimer || publishingProfile) return;
      profileTimer = setTimeout(() => {
        profileTimer = undefined;
        if (!profileEligible()) return;
        publishingProfile = true;
        const revision = profileRevision;
        void profileEditor
          .publish()
          .catch(() => undefined)
          .finally(() => {
            publishingProfile = false;
            if (!mounted) return;
            if (revision === profileRevision && profileEditor.draft()) {
              profileRetryDelay = Math.min(
                Math.max(15_000, profileRetryDelay * 2),
                300_000,
              );
            } else {
              profileRetryDelay = 0;
            }
            scheduleProfilePublish();
          });
      }, profileRetryDelay);
    }

    const unsubscribeEditor = profileEditor.subscribe(() => {
      const revision = profileEditor.getSnapshot().editRevision;
      if (revision !== profileRevision) {
        profileRevision = revision;
        profileRetryDelay = 0;
        clearTimeout(profileTimer);
        profileTimer = undefined;
      }
      scheduleProfilePublish();
    });
    const unsubscribeAccount = marmotSession.subscribe(() => {
      speech.accountReady();
      void speech.reconcile();
      updateBackupConditions();
      scheduleProfilePublish();
    });
    const unsubscribeProfileRelays = relays.subscribe(scheduleProfilePublish);
    const unsubscribeProfileLock = lock.subscribe(() => {
      if (lock.getState().locked) profileEditor.cancel();
      scheduleProfilePublish();
    });
    const profileAppState = AppState.addEventListener("change", (state) => {
      if (state !== "active") profileEditor.cancel();
      scheduleProfilePublish();
    });
    scheduleProfilePublish();
    const battery = addBatteryStateListener(() => {
      updateBackupConditions();
      void speech.power();
    });
    const network = addNetworkStateListener(({ isConnected }) => {
      updateBackupConditions();
      if (isConnected && AppState.currentState === "active") catchUpMessaging();
    });
    return () => {
      mounted = false;
      stopSpeech();
      unsubscribeSpeechCall();
      unsubscribeSpeechPrivacy();
      lowPower.remove();
      memory.remove();
      stopGroupCalls();
      if (checkAfterPrompt) clearTimeout(checkAfterPrompt);
      unsubscribeLock();
      unsubscribeChats();
      unsubscribeMedia();
      unsubscribeAccount();
      unsubscribeProfileRelays();
      unsubscribeProfileLock();
      unsubscribeEditor();
      profileAppState.remove();
      clearTimeout(profileTimer);
      profileEditor.cancel();
      battery.remove();
      network.remove();
      subscription.remove();
      dbChanges.remove();
      avatars.setActive(false);
      void marmotSession.stop().catch(() => undefined);
      callSignaling.stop();
      relays.stop();
    };
  }, [
    db,
    identity,
    relays,
    callSignaling,
    calling,
    lock,
    avatars,
    marmotSession,
    chatPreferences,
    mediaSdk,
    profileEditor,
    publicMetadata,
    speech,
    privacy,
  ]);
  return null;
}
