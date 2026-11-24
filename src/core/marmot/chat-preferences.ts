import type { Database } from "@/db";
import { preference, setPreference } from "@/db/queries";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

const key = "chat.enabled";
const presentationKey = "chat.presentation";
const groupCreationKey = (group: string) => `chat.created.${group}`;

export const chatPresentationControls = {
  textSize: { min: 12, max: 28, step: 1, initial: 16 },
  rounding: { min: 0, max: 28, step: 2, initial: 18 },
};

const presentationValue = (control: keyof typeof chatPresentationControls) => {
  const { min, max, step, initial } = chatPresentationControls[control];
  return z.number().int().min(min).max(max).multipleOf(step).catch(initial);
};

const chatPresentation = z.object({
  textSize: presentationValue("textSize"),
  rounding: presentationValue("rounding"),
});

export type ChatPresentation = z.infer<typeof chatPresentation>;

function readPresentation(db: Database): ChatPresentation {
  try {
    return chatPresentation.parse(
      JSON.parse(preference(db, presentationKey) ?? "{}"),
    );
  } catch {
    return chatPresentation.parse({});
  }
}

export function createChatPreferences(db: Database) {
  let enabled = preference(db, key) !== "false";
  const listeners = new Set<() => void>();
  const presentationListeners = new Set<() => void>();
  let presentation = readPresentation(db);
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
    presentation: () => presentation,
    setPresentation(control: keyof ChatPresentation, value: number) {
      const next = chatPresentation.parse({
        ...presentation,
        [control]: Math.round(value),
      });
      if (next[control] === presentation[control]) return;
      setPreference(db, presentationKey, JSON.stringify(next));
      presentation = next;
      for (const listener of presentationListeners) listener();
    },
    subscribePresentation(listener: () => void) {
      presentationListeners.add(listener);
      return () => {
        presentationListeners.delete(listener);
      };
    },
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
    recordGroupCreation(group: string, createdAt: number) {
      setPreference(db, groupCreationKey(group), String(createdAt));
    },
    clearGroupCreation(group: string) {
      db.delete(settings)
        .where(eq(settings.key, groupCreationKey(group)))
        .run();
    },
    groupCreatedAt(group: string) {
      return z.coerce
        .number()
        .int()
        .positive()
        .safeParse(preference(db, groupCreationKey(group))).data;
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
