import { asc, eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { createContext, useContext, useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { initializeIdentity } from "@/core/identity";
import { createMessagingRuntime } from "@/core/messaging";
import { openDatabase } from "@/db";
import { createMessagingRepository } from "@/db/messaging";
import { preference } from "@/db/queries";
import { callHistory, contacts, relaySettings } from "@/db/schema";

async function start() {
  const db = await openDatabase();
  try {
    const identity = await initializeIdentity(db);
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
    ] = await Promise.all([
      import("@/core/calling/controller"),
      import("@/core/calling/trystero"),
      import("@/core/calling/native-audio"),
    ]);
    const calling = createCallController({
      localKey: identity.publicKey,
      randomId: randomCallId,
      openMedia: trysteroMedia(signer, {
        get(peerKey) {
          const row = db
            .select({ allowed: contacts.allowIncomingVideo })
            .from(contacts)
            .where(eq(contacts.publicKey, peerKey))
            .get();
          return row ? (row.allowed ? "always" : "ask") : "unknown";
        },
        allow(peerKey) {
          return (
            db
              .update(contacts)
              .set({ allowIncomingVideo: true })
              .where(eq(contacts.publicKey, peerKey))
              .run().changes === 1
          );
        },
      }),
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
    return {
      db,
      identity,
      chat,
      messaging,
      calling,
      theme: preference(db, "theme"),
      haptics: preference(db, "haptics") !== "off",
    };
  } catch (error) {
    db.$client.closeSync();
    throw error;
  }
}

let initialization: ReturnType<typeof start> | undefined;
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
  const { db, messaging, calling } = useLocal();
  const query = useMemo(
    () => db.select().from(relaySettings).orderBy(asc(relaySettings.url)),
    [db],
  );
  const { data: relays } = useLiveQuery(query, [query]);
  const enabled = useMemo(
    () => relays.filter((relay) => relay.enabled).map((relay) => relay.url),
    [relays],
  );
  useEffect(() => {
    const update = (state: typeof AppState.currentState) => {
      if (state === "active") {
        calling.setForeground(true);
        messaging.start(enabled);
      } else if (state === "background") {
        calling.setForeground(false);
        if (!calling.isRequestingMicrophone()) messaging.stop();
      }
    };
    update(AppState.currentState);
    const subscription = AppState.addEventListener("change", update);
    return () => {
      subscription.remove();
      messaging.stop();
    };
  }, [enabled, messaging, calling]);
  return null;
}
