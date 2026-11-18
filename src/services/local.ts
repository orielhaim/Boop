import { asc } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { createContext, useContext, useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { initializeIdentity } from "@/core/identity";
import { createMessagingRuntime } from "@/core/messaging";
import { openDatabase } from "@/db";
import { createMessagingRepository } from "@/db/messaging";
import { preference } from "@/db/queries";
import { relaySettings } from "@/db/schema";

async function start() {
  const db = await openDatabase();
  try {
    const identity = await initializeIdentity(db);
    const chat = createMessagingRepository(db);
    const messaging = await createMessagingRuntime({ db, identity, chat });
    return {
      db,
      identity,
      chat,
      messaging,
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
  const { db, messaging } = useLocal();
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
      if (state === "active") messaging.start(enabled);
      else messaging.stop();
    };
    update(AppState.currentState);
    const subscription = AppState.addEventListener("change", update);
    return () => {
      subscription.remove();
      messaging.stop();
    };
  }, [enabled, messaging]);
  return null;
}
