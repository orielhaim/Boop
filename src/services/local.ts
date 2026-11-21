import { createMediaSdk } from "@/core/media";
import { createNativeLinkPreviews } from "@/core/messaging/native-link-previews";
import { createAttachmentMedia } from "@/core/media/service";
import { File } from "expo-file-system";
import { uploadAvatar } from "@/core/avatars/blossom";
import { createProfileEditor } from "@/core/avatars/editor";
import { createAvatars } from "@/core/avatars/service";
import { asc } from "drizzle-orm";
import { randomUUID } from "expo-crypto";
import { getLocales } from "expo-localization";
import { addDatabaseChangeListener } from "expo-sqlite";
import { useEffect } from "react";
import { AppState } from "react-native";
import { createCallSignalingService } from "@/core/calling/signaling-service";
import { createPublicMetadata } from "@/core/nostr/public-metadata";
import { createRelayService } from "@/core/nostr/relay-service";
import { createCallController } from "@/core/calling/controller";
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
import { createMessagingService } from "@/core/messaging/runtime";
import { createConversationFeed } from "@/core/messaging/conversations";
import { messagingMetric } from "@/core/messaging/diagnostics";
import { createHistoryLoader } from "@/core/messaging/history";
import { configuredRelays, inboxIntentKey } from "@/core/nostr/config";
import { createPrivacy } from "@/core/privacy";
import { type AppLock, createAppLock } from "@/core/security/app-lock";
import { authenticateApp, protectAppWindow } from "@/core/security/native-auth";
import { loadTranslationEngine } from "@/core/translation/native";
import {
  initializeTranslationPreferences,
  translationPreviewTarget,
} from "@/core/translation/preferences";
import { createTranslationService } from "@/core/translation/service";
import { openDatabase } from "@/db";
import { createMessagingRepository } from "@/db/messaging";
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
    const { identity, signer, fresh } = await initializeIdentity(db);
    messagingMetric("identity ready", {
      ms: performance.now() - identityStarted,
    });
    initializeTranslationPreferences(db, resolveLanguage(i18n.language));
    seedRelays(db, fresh);
    const chatPreferences = createChatPreferences(db);
    const chat = createMessagingRepository(db);
    const privacy = createPrivacy(db, chat, identity.publicKey);
    const mediaSdk = createMediaSdk(db, signer);
    const attachments = createAttachmentMedia(
      chat,
      privacy.isBlocked,
      mediaSdk,
    );
    const history = createHistoryLoader(chat);
    const conversations = createConversationFeed(chat, history, () =>
      translationPreviewTarget(db),
    );
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
    const messaging = createMessagingService({
      relays,
      readState: (key) => preference(db, key),
      writeState: (key, value) => setPreference(db, key, value),
      createId: randomUUID,
      signer,
      chat,
      privacy,
      media: attachments,
    });
    const lock = createAppLock({
      read: (key) => preference(db, key),
      write: (key, value) => setPreference(db, key, value),
      startActive: AppState.currentState === "active",
      authenticate: authenticateApp,
      protect: protectAppWindow,
    });
    const publicMetadata = createPublicMetadata(
      relays,
      identity.publicKey,
      () => AppState.currentState === "active" && !lock.getState().locked,
    );
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
      (filename, signal) =>
        uploadAvatar(mediaSdk, new File(localDirectory, filename), signal),
      publicMetadata,
    );
    const marmotSession = createMarmotSession(async (configuration) => {
      const state = await initializeMarmotIdentity(
        db,
        identity.publicKey,
        configuration,
      );
      try {
        for (const key of privacy.blockedKeys())
          await marmot.setBlocked(key, true);
      } catch (failure) {
        await marmot.closeAccount();
        throw failure;
      }
      return state;
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
    appLock = lock;
    messagingMetric("local startup ready", { ms: performance.now() - started });
    return {
      db,
      translation: createTranslationService(
        createDerivedTranslations(db, marmotViewport.incomingText),
        loadTranslationEngine,
      ),
      identity,
      avatars,
      attachments,
      previews,
      mediaSdk,
      profileEditor,
      publicMetadata,
      privacy,
      chat,
      history,
      conversations,
      messaging,
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

export function LocalSessionLifecycle() {
  const {
    db,
    relays,
    callSignaling,
    calling,
    lock,
    avatars,
    marmotSession,
    chatPreferences,
  } = useLocal();
  useEffect(() => {
    const databasePath =
      db.$client.getFirstSync<{ file: string }>(
        "SELECT file FROM pragma_database_list WHERE name = 'main'",
      )?.file ?? db.$client.databasePath;
    let checkAfterPrompt: ReturnType<typeof setTimeout> | undefined;
    const readRelays = () =>
      db.select().from(relaySettings).orderBy(asc(relaySettings.url)).all();
    let rows = readRelays();
    let intent = preference(db, inboxIntentKey);
    let queued = false;
    let mounted = true;
    let relaysChanged = false;
    function connectMessaging() {
      if (!chatPreferences.enabled()) void marmotSession.stop();
      else if (AppState.currentState === "active")
        void marmotSession.start(configuredRelays(rows, intent));
    }
    function connect() {
      callSignaling.start();
      const configuration = configuredRelays(rows, intent);
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
    const update = (state: typeof AppState.currentState) => {
      if (checkAfterPrompt) clearTimeout(checkAfterPrompt);
      avatars.setActive(state === "active" && !lock.getState().locked);
      if (state === "active") {
        calling.setForeground(true);
        connect();
      } else if (state === "background" && !lock.getState().authenticating) {
        background();
      }
    };
    const unsubscribeLock = lock.subscribe(() => {
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
    const unsubscribeChats = chatPreferences.subscribe(connectMessaging);
    return () => {
      mounted = false;
      if (checkAfterPrompt) clearTimeout(checkAfterPrompt);
      unsubscribeLock();
      unsubscribeChats();
      subscription.remove();
      dbChanges.remove();
      avatars.setActive(false);
      void marmotSession.stop();
      callSignaling.stop();
      relays.stop();
    };
  }, [
    db,
    relays,
    callSignaling,
    calling,
    lock,
    avatars,
    marmotSession,
    chatPreferences,
  ]);
  return null;
}
