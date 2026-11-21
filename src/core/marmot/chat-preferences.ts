import type { Database } from "@/db";
import { preference, setPreference } from "@/db/queries";

const key = "chat.enabled";

export function createChatPreferences(db: Database) {
  let enabled = preference(db, key) !== "false";
  const listeners = new Set<() => void>();
  return {
    enabled: () => enabled,
    setEnabled(value: boolean) {
      if (enabled === value) return;
      setPreference(db, key, String(value));
      enabled = value;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
