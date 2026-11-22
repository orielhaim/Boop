import { createContext, useContext, useSyncExternalStore } from "react";
import type { initializeLocal } from "./local";

type LocalServices = Awaited<ReturnType<typeof initializeLocal>>;

// Keep the provider identity stable when Fast Refresh reloads service setup.
export const LocalContext = createContext<LocalServices | null>(null);

export function useLocal() {
  const local = useContext(LocalContext);
  if (!local) throw new Error("Local services are unavailable");
  return local;
}

export function useChatsEnabled() {
  const { chatPreferences } = useLocal();
  return useSyncExternalStore(
    chatPreferences.subscribe,
    chatPreferences.enabled,
  );
}
