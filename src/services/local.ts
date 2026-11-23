import { createAudioController } from "@/core/audio/controller";
import { createNativePlayback, setupPlayback } from "@/core/audio/engine";
import { createAudioSources } from "@/core/audio/sources";
import { speeds, voiceOrigin, type Track } from "@/core/audio/types";
import { audioPersistence } from "@/db/audio";
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
import { createDownloadManager } from "@/core/downloads/manager";
import { createBlossomDownloads } from "@/core/downloads/blossom-transfer";
import { marmotDownloads } from "@/core/downloads/marmot";
import { downloadTransports } from "@/core/downloads/transport";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { downloadStore } from "@/db/downloads";
import { priority as speechPriority } from "@/core/speech/scheduler";
import { createMediaSdk } from "@/core/media";
import { createNativeLinkPreviews } from "@/core/messaging/native-link-previews";
import { File } from "expo-file-system";
import { getRandomValues } from "expo-crypto";
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
import {
  accountDownloadKey,
  accountSigner,
  copyInstallationPreferences,
  removeLocalAccount,
  selectedAccount,
  selectAccount,
} from "@/core/identity";
import { createChatPreferences } from "@/core/marmot/chat-preferences";
import { createMarmotSession } from "@/core/marmot/account-session";
import { createMarmotViewport } from "@/core/marmot/viewport";
import { marmot, marmotAccounts } from "@/core/marmot/native";
import { toNpub } from "@/core/identity/keys";
import { messagingMetric } from "@/core/messaging/diagnostics";
import {
  configuredRelays,
  defaultRelays,
  inboxIntentKey,
} from "@/core/nostr/config";
import { createPrivacy } from "@/core/privacy";
import { type AppLock, createAppLock } from "@/core/security/app-lock";
import { authenticateApp, protectAppWindow } from "@/core/security/native-auth";
import { loadTranslationEngine } from "@/core/translation/native";
import { initializeTranslationPreferences } from "@/core/translation/preferences";
import { createTranslationService } from "@/core/translation/service";
import { createVoiceTranscription, speechSource } from "@/core/speech/service";
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
  const installation = await openDatabase();
  let db = installation;
  try {
    const initialRelays = configuredRelays(defaultRelays, null);
    const { account, accounts } = await selectedAccount(
      installation,
      initialRelays,
    );
    const setup =
      account && !account.unlinked && account.readiness !== "recovery_required"
        ? await marmotAccounts.onboarding(account.key, { action: "read" })
        : null;
    const ready =
      account &&
      !account.signedOut &&
      !account.unlinked &&
      (account.readiness === "local_ready" ||
        account.readiness === "publishing" ||
        account.readiness === "network_ready") &&
      (!setup || setup.ready);
    if (account && !ready) {
      for (const old of accounts) {
        if (old.key !== account.key && !old.signedOut && !old.unlinked)
          await marmotAccounts.signOut(old.key);
      }
    }
    const initialProfile = ready
      ? await marmotAccounts.selectSigner(account.key)
      : null;
    if (ready) {
      selectAccount(installation, account.key);
      for (const old of accounts) {
        if (old.key === account.key) continue;
        await removeLocalAccount(old.key);
      }
      db = await openDatabase(account.key);
      if (preference(db, "relay.settings.initialized") === null)
        copyInstallationPreferences(installation, db);
      installation.$client.closeSync();
    }
    const language = readLanguagePreference(db);
    await i18n.changeLanguage(
      preferredLanguage(
        language,
        language === "auto" ? getLocales()[0]?.languageCode : undefined,
      ),
    );
    const lock = createAppLock({
      read: (key) => preference(db, key),
      write: (key, value) => setPreference(db, key, value),
      startActive: AppState.currentState === "active",
      authenticate: authenticateApp,
      protect: protectAppWindow,
    });
    appLock = lock;
    if (!ready || !initialProfile) {
      return {
        status: "welcome" as const,
        db,
        account,
        setup,
        previousAccount: accounts.find((item) => item.key !== account?.key)
          ?.key,
        relays: initialRelays,
        lock,
        theme: preference(db, "theme"),
        haptics: preference(db, "haptics") !== "off",
      };
    }
    const identity = { publicKey: account.key, npub: toNpub(account.key) };
    let retired = false;
    const isCurrent = () => !retired;
    const active = () =>
      isCurrent() &&
      AppState.currentState === "active" &&
      !lock.getState().locked;
    const signer = accountSigner(account.key, active);
    const downloadKey = await accountDownloadKey(account.key);
    initializeTranslationPreferences(db, resolveLanguage(i18n.language));
    purgeExpiredOpenedMessages(db);
    seedRelays(db);
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
      isCurrent,
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
      isCurrent,
      () => marmotAccounts.networkReady(account.key),
    );
    let beforeAccountClose: (() => Promise<void>) | undefined;
    const marmotSession = createMarmotSession({
      async open(configuration, mediaOrigin) {
        if (!isCurrent()) throw new Error("AccountClosed");
        const state = await marmotAccounts.open(
          account.key,
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
      close: () => marmot.closeAccount(),
      beforeClose: () => beforeAccountClose?.(),
    });
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
    const pendingVoiceNotes = new Map<
      string,
      NonNullable<ReturnType<typeof speechSource>>
    >();
    function admitDownloadedVoice() {
      if (!active() || marmotSession.status() !== "ready") return;
      for (const [key, voice] of pendingVoiceNotes) {
        pendingVoiceNotes.delete(key);
        speech.availableLocally(voice, speechPriority.download);
      }
    }
    const downloadScope = bytesToHex(sha256(downloadKey));
    const downloads = createDownloadManager({
      store: downloadStore(db, identity.publicKey, downloadKey, (size) =>
        getRandomValues(new Uint8Array(size)),
      ),
      transport: downloadTransports(
        marmotDownloads,
        createBlossomDownloads(
          downloadScope,
          () => mediaSdk.configured("attachment").map(({ origin }) => origin),
          publicMetadata.discoverBlossomServers,
        ),
      ),
      eligible: active,
      available: (source) =>
        source.kind === "http" ||
        (chatPreferences.enabled() && marmotSession.status() === "ready"),
      authorized: (source) =>
        source.kind === "http" ||
        (!privacy.isBlocked(source.sender) &&
          !chatPreferences.hidden(source.target[0]).includes(source.target[1])),
      completed: (source) => {
        if (source.kind !== "marmot" || !source.voice) return;
        const { voice } = source;
        pendingVoiceNotes.set(JSON.stringify(voice.target), voice);
        admitDownloadedVoice();
      },
    });
    const read = (key: string) => preference(db, key);
    const write = (key: string, value: string) => setPreference(db, key, value);
    const allowed = (track: Track) =>
      track.kind === "device" ||
      ((track.source.expiresAt === null ||
        track.source.expiresAt > Date.now()) &&
        (track.source.kind === "http" ||
          (chatPreferences.enabled() &&
            !privacy.isBlocked(track.source.sender) &&
            !chatPreferences
              .hidden(track.source.target[0])
              .includes(track.source.target[1]))));
    let closingAudioAttachments = false;
    const audioSources = createAudioSources({
      scope: downloadScope,
      downloads,
      ready: () =>
        !closingAudioAttachments && marmotSession.status() === "ready",
      allowed,
      canDownload: active,
      canImport: () => !lock.getState().locked,
      blocked: privacy.isBlocked,
      subscribePrivacy: privacy.subscribe,
    });
    const playback = audioPersistence({
      account: identity.publicKey,
      key: downloadKey,
      random: (size) => getRandomValues(new Uint8Array(size)),
      read,
      write,
    });
    const nativePlayback = createNativePlayback();
    const audio = createAudioController({
      saved: playback.load(),
      save: playback.save,
      preferences: {
        external: read("audio.open") === "external",
        voiceSpeed:
          speeds.find((speed) => String(speed) === read("audio.voiceSpeed")) ??
          1,
      },
      savePreferences({ external, voiceSpeed }) {
        write("audio.open", external ? "external" : "internal");
        write("audio.voiceSpeed", String(voiceSpeed));
      },
      acquire: audioSources.acquire,
      setup: setupPlayback,
      engine: nativePlayback.open,
      disposeEngine: nativePlayback.dispose,
      allowed,
      listened(track) {
        const origin = voiceOrigin(track);
        if (origin) chatPreferences.markListened(origin[0], origin[1]);
        if (
          track.kind === "attachment" &&
          track.source.kind === "marmot" &&
          track.source.voice
        )
          speech.availableLocally(track.source.voice, speechPriority.playing);
      },
      genericTitle: () => i18n.t("audio:privateTitle"),
    });
    audio.revalidate();
    audio.privacy(lock.getState());
    lock.subscribe(() => audio.privacy(lock.getState()));
    privacy.subscribe(audio.revalidate);
    chatPreferences.subscribe(audio.revalidate);
    calling.store.subscribe(({ call }) =>
      audio.call(Boolean(call && call.phase !== "ended")),
    );
    marmotSession.subscribe(() => {
      if (marmotSession.status() === "ready") closingAudioAttachments = false;
    });
    beforeAccountClose = async () => {
      closingAudioAttachments = true;
      pendingVoiceNotes.clear();
      await audio.close();
      await Promise.all([
        speech.beforeAccountClose(),
        downloads.beforeAccountClose(),
      ]);
    };
    appLock = lock;
    messagingMetric("local startup ready", { ms: performance.now() - started });
    return {
      status: "ready" as const,
      db,
      isCurrent,
      initialProfile,
      async replaceIdentity(importToken: string, live: () => boolean) {
        const target = await marmotAccounts.install(
          { importToken },
          initialRelays,
        );
        if (!live()) {
          if (target !== account.key) await marmotAccounts.remove(target);
          if (!chatPreferences.enabled()) await marmot.closeAccount(true);
          return false;
        }
        if (target === account.key) return false;
        const installation = await openDatabase();
        try {
          copyInstallationPreferences(db, installation);
          selectAccount(installation, target);
          retired = true;
          calling.end();
          callSignaling.stop();
          relays.stop();
          avatars.setActive(false);
          profileEditor.cancel();
          await audio.close();
          await marmotSession.stop();
          await marmotAccounts.signOut(account.key);
          downloadKey.fill(0);
          await marmotAccounts.shutdown();
          return true;
        } finally {
          installation.$client.closeSync();
        }
      },
      translation: createTranslationService(
        createDerivedTranslations(db, marmotViewport.incomingText),
        loadTranslationEngine,
      ),
      identity,
      speech,
      downloads,
      audio,
      audioSources,
      admitDownloadedVoice,
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
    downloads,
    admitDownloadedVoice,
    privacy,
    isCurrent,
  } = useLocal();
  useEffect(() => {
    const stopSpeech = speech.start();
    downloads.network(false, false);
    const stopDownloads = downloads.start();
    const unsubscribeSpeechCall = calling.store.subscribe(speech.sync);
    const unsubscribeSpeechPrivacy = privacy.subscribe(() => {
      void speech.reconcile();
      void downloads.reconcile();
    });
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
      if (!isCurrent() || lock.getState().locked) return;
      if (!chatPreferences.enabled())
        void marmotSession
          .stop()
          .then(() => {
            if (isCurrent() && !chatPreferences.enabled())
              return marmot.closeAccount(true);
          })
          .catch(() => undefined);
      else if (AppState.currentState === "active")
        void marmotSession.start(configuration, mediaOrigin);
    }
    function connect() {
      if (!isCurrent() || lock.getState().locked) return;
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
      downloads.sync();
      speech.sync();
      if (state === "active") admitDownloadedVoice();
      if (checkAfterPrompt) clearTimeout(checkAfterPrompt);
      avatars.setActive(state === "active" && !lock.getState().locked);
      if (state === "active") {
        calling.setForeground(true);
        connect();
        if (!lock.getState().locked) marmotSession.reconnected();
        catchUpMessaging();
      } else if (state === "background" && !lock.getState().authenticating) {
        background();
      }
      updateBackupConditions();
    };
    const unsubscribeLock = lock.subscribe(() => {
      downloads.sync();
      speech.sync();
      admitDownloadedVoice();
      updateUnlocks();
      if (AppState.currentState === "active") {
        if (lock.getState().locked) {
          callSignaling.stop();
          relays.stop();
        } else {
          connect();
          catchUpMessaging();
        }
      }
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
        isCurrent() &&
        AppState.currentState === "active" &&
        !lock.getState().locked &&
        Boolean(publicMetadata.profileRelayKey()) &&
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
      if (marmotSession.status() === "ready") downloads.accountReady();
      admitDownloadedVoice();
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
    let networkWasConnected = false;
    let networkRevision = 0;
    const updateDownloadNetwork = ({
      isConnected,
      type,
    }: Awaited<ReturnType<typeof getNetworkStateAsync>>) =>
      downloads.network(
        isConnected !== false,
        type === NetworkStateType.CELLULAR,
      );
    const network = addNetworkStateListener((state) => {
      const { isConnected } = state;
      networkRevision += 1;
      updateDownloadNetwork(state);
      const reconnected = isConnected && !networkWasConnected;
      networkWasConnected = isConnected === true;
      updateBackupConditions();
      if (isConnected && AppState.currentState === "active") {
        if (reconnected && !lock.getState().locked) marmotSession.reconnected();
        catchUpMessaging();
      }
    });
    void getNetworkStateAsync()
      .then((state) => {
        if (mounted && networkRevision === 0) updateDownloadNetwork(state);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      stopSpeech();
      stopDownloads();
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
    downloads,
    admitDownloadedVoice,
    privacy,
    isCurrent,
  ]);
  return null;
}
