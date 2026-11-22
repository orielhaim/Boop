import { createContext, useContext, useSyncExternalStore } from "react";
import type { initializeLocal } from "./local";

export type LocalServices = Extract<
  Awaited<ReturnType<typeof initializeLocal>>,
  { status: "ready" }
>;

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

export function useChatPresentation() {
  const { chatPreferences } = useLocal();
  return useSyncExternalStore(
    chatPreferences.subscribePresentation,
    chatPreferences.presentation,
  );
}
