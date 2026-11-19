import { asc } from "drizzle-orm";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { getLocales } from "expo-localization";
import { addDatabaseChangeListener } from "expo-sqlite";
import { useEffect } from "react";
import { AppState } from "react-native";
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
import { initializeIdentity } from "@/core/identity";
import { toNpub } from "@/core/identity/keys";
import { createMessagingRuntime } from "@/core/messaging";
import { createConversationFeed } from "@/core/messaging/conversations";
import { messagingMetric } from "@/core/messaging/diagnostics";
import { createHistoryLoader } from "@/core/messaging/history";
import { configuredRelays, inboxIntentKey } from "@/core/nostr/config";
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
import { createTranslationCache } from "@/db/translations";
import { i18n, preferredLanguage, resolveLanguage } from "@/i18n";
import { readLanguagePreference } from "@/i18n/preference";
import { useLocal } from "./local-context";

export { useLocal } from "./local-context";

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
    const chat = createMessagingRepository(db);
    const history = createHistoryLoader(chat);
    const conversations = createConversationFeed(chat, history, () =>
      translationPreviewTarget(db),
    );
    const messagingStarted = performance.now();
    const messaging = createMessagingRuntime({
      db,
      signer,
      chat,
    });
    messagingMetric("runtime initialized", {
      ms: performance.now() - messagingStarted,
    });
    const lock = createAppLock({
      read: (key) => preference(db, key),
      write: (key, value) => setPreference(db, key, value),
      startActive: AppState.currentState === "active",
      authenticate: authenticateApp,
      protect: protectAppWindow,
    });
    const calling = createCallController({
      localKey: identity.publicKey,
      randomId: randomCallId,
      openMedia: trysteroMedia(
        signer,
        {
          get(peerKey) {
            const row = contactByKey(db, peerKey).get();
            return row
              ? row.allowIncomingVideo
                ? "always"
                : "ask"
              : "unknown";
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
            avatarUrl: contact?.avatarUrl,
            incoming: invite.recipientKey === identity.publicKey,
            privateMode,
            signal,
            onRouting,
          });
        },
      ),
      prepareMedia: initializeCallingRuntime,
      send: messaging.sendCall,
      tone: callTone,
      record: (entry) => saveCallRecord(db, entry),
      hasRecord: (id, invitationId) => {
        const entry = callById(db, id);
        return invitationId
          ? entry?.invitationIds.includes(invitationId) === true
          : !!entry;
      },
    });
    messaging.subscribeCalls(calling.receive);
    const nativeOpen = attachSystemPresentation(calling, {
      privateMode: () => lock.getState().enabled,
      subscribe: lock.subscribe,
    });
    appLock = lock;
    messagingMetric("local startup ready", { ms: performance.now() - started });
    return {
      db,
      translation: createTranslationService(
        createTranslationCache(db),
        loadTranslationEngine,
        (text) => digestStringAsync(CryptoDigestAlgorithm.SHA256, text),
      ),
      identity,
      chat,
      history,
      conversations,
      messaging,
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

export function MessagingLifecycle() {
  const { db, messaging, calling, lock, conversations } = useLocal();
  useEffect(() => {
    const stopFeed = conversations.start();
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
    function connect() {
      messaging.start(configuredRelays(rows, intent));
    }
    const dbChanges = addDatabaseChangeListener(
      ({ databaseFilePath, tableName }) => {
        if (databaseFilePath !== databasePath) return;
        conversations.externalChange(tableName);
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
    function background() {
      calling.setForeground(false);
      if (!calling.isRequestingMicrophone()) messaging.stop();
    }
    const update = (state: typeof AppState.currentState) => {
      if (checkAfterPrompt) clearTimeout(checkAfterPrompt);
      conversations.setPrefetchEnabled(
        state === "active" && !lock.getState().locked,
      );
      if (state === "active") {
        calling.setForeground(true);
        connect();
      } else if (state === "background" && !lock.getState().authenticating) {
        background();
      }
    };
    const unsubscribeLock = lock.subscribe(() => {
      conversations.setPrefetchEnabled(
        AppState.currentState === "active" && !lock.getState().locked,
      );
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
    return () => {
      mounted = false;
      if (checkAfterPrompt) clearTimeout(checkAfterPrompt);
      unsubscribeLock();
      subscription.remove();
      dbChanges.remove();
      stopFeed();
      messaging.stop();
    };
  }, [db, messaging, calling, lock, conversations]);
  return null;
}
