import type { Database } from "@/db";
import { preference, setPreference } from "@/db/queries";
import { z } from "zod";

const key = "chat.enabled";

export function createChatPreferences(db: Database) {
  let enabled = preference(db, key) !== "false";
  const listeners = new Set<() => void>();
  const messageLists = new Map<string, readonly string[]>();
  const messageIds = z.array(z.string());
  function list(group: string, kind: "pin" | "hidden" | "listened") {
    const key = `chat.${kind}.${group}`;
    const cached = messageLists.get(key);
    if (cached) return cached;
    let items: readonly string[] = [];
    try {
      items = messageIds.parse(JSON.parse(preference(db, key) ?? "[]"));
    } catch {
      // A corrupt presentation preference has no effect on native history.
    }
    messageLists.set(key, items);
    return items;
  }
  function setMessage(
    group: string,
    kind: "pin" | "hidden" | "listened",
    id: string,
    present: boolean,
  ) {
    const current = list(group, kind);
    if (current.includes(id) === present) return;
    const next =
      present && kind === "listened"
        ? [...current.slice(-1999), id]
        : present
          ? [...current, id]
          : current.filter((item) => item !== id);
    const key = `chat.${kind}.${group}`;
    setPreference(db, key, JSON.stringify(next));
    messageLists.set(key, next);
    for (const listener of listeners) listener();
  }
  return {
    pinned: (group: string) => list(group, "pin"),
    hidden: (group: string) => list(group, "hidden"),
    listened: (group: string) => list(group, "listened"),
    markListened: (group: string, id: string) =>
      setMessage(group, "listened", id, true),
    setPin: (group: string, id: string, present: boolean) =>
      setMessage(group, "pin", id, present),
    hide(group: string, id: string) {
      setMessage(group, "pin", id, false);
      setMessage(group, "hidden", id, true);
    },
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
