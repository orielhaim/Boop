import { asc, eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { getLocales } from "expo-localization";
import { createContext, useContext, useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { initializeIdentity } from "@/core/identity";
import { toNpub } from "@/core/identity/keys";
import { createMessagingRuntime } from "@/core/messaging";
import { configuredRelays, inboxIntentKey } from "@/core/nostr/config";
import { type AppLock, createAppLock } from "@/core/security/app-lock";
import { authenticateApp, protectAppWindow } from "@/core/security/native-auth";
import { openDatabase } from "@/db";
import { createMessagingRepository } from "@/db/messaging";
import {
  contactByKey,
  preference,
  setPreference,
  updateContactPreferences,
} from "@/db/queries";
import { seedRelays } from "@/db/relays";
import { callHistory, relaySettings, settings } from "@/db/schema";
import { i18n, preferredLanguage } from "@/i18n";
import { readLanguagePreference } from "@/i18n/preference";

async function start() {
  const db = await openDatabase();
  try {
    const language = readLanguagePreference(db);
    await i18n.changeLanguage(
      preferredLanguage(
        language,
        language === "auto" ? getLocales()[0]?.languageCode : undefined,
      ),
    );
    const fresh = preference(db, "identity.publicKey") === null;
    const identity = await initializeIdentity(db);
    seedRelays(db, fresh);
    const chat = createMessagingRepository(db);
    const { messaging, signer } = await createMessagingRuntime({
      db,
      identity,
      chat,
    });
    const [
      { createCallController },
      { initializeCallingRuntime, randomCallId, trysteroMedia },
      { callTone },
      { attachSystemPresentation, openTelecomAudio },
    ] = await Promise.all([
      import("@/core/calling/controller"),
      import("@/core/calling/trystero"),
      import("@/core/calling/native-audio"),
      import("@/core/calling/system-calling"),
    ]);
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
      record: (entry) =>
        db.insert(callHistory).values(entry).onConflictDoNothing().run(),
      hasRecord: (id) =>
        !!db
          .select({ id: callHistory.id })
          .from(callHistory)
          .where(eq(callHistory.id, id))
          .get(),
    });
    messaging.subscribeCalls(calling.receive);
    const nativeOpen = attachSystemPresentation(calling, {
      privateMode: () => lock.getState().enabled,
      subscribe: lock.subscribe,
    });
    appLock = lock;
    return {
      db,
      identity,
      chat,
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

export const LocalContext = createContext<Awaited<
  ReturnType<typeof start>
> | null>(null);

export function useLocal() {
  const local = useContext(LocalContext);
  if (!local) throw new Error("Local services are unavailable");
  return local;
}

export function MessagingLifecycle() {
  const { db, messaging, calling, lock } = useLocal();
  const query = useMemo(
    () => db.select().from(relaySettings).orderBy(asc(relaySettings.url)),
    [db],
  );
  const { data: relays } = useLiveQuery(query, [query]);
  const intentQuery = useMemo(
    () => db.select().from(settings).where(eq(settings.key, inboxIntentKey)),
    [db],
  );
  const { data: intent } = useLiveQuery(intentQuery, [intentQuery]);
  const configuration = useMemo(
    () => configuredRelays(relays, intent[0]?.value ?? null),
    [relays, intent],
  );
  useEffect(() => {
    let checkAfterPrompt: ReturnType<typeof setTimeout> | undefined;
    function background() {
      calling.setForeground(false);
      if (!calling.isRequestingMicrophone()) messaging.stop();
    }
    const update = (state: typeof AppState.currentState) => {
      if (checkAfterPrompt) clearTimeout(checkAfterPrompt);
      if (state === "active") {
        calling.setForeground(true);
        messaging.start(configuration);
      } else if (state === "background" && !lock.getState().authenticating) {
        background();
      }
    };
    const unsubscribeLock = lock.subscribe(() => {
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
      if (checkAfterPrompt) clearTimeout(checkAfterPrompt);
      unsubscribeLock();
      subscription.remove();
    };
  }, [configuration, messaging, calling, lock]);
  useEffect(() => () => messaging.stop(), [messaging]);
  return null;
}
