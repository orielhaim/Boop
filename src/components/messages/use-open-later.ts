import type { BlockedUsers } from "@/core/marmot/blocked-users";
import { useLayoutEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { MarmotConversation, MarmotWindow } from "@/core/marmot/native";
import {
  createOpenLaterResolver,
  type OpenLaterState,
} from "@/core/messaging/special-messages/open-conversation";
import { timeLockKind } from "@/core/messaging/special-messages/timelock";
import {
  purgeExpiredOpenedMessages,
  readOpenedMessage,
  removeOpenedMessage,
  saveOpenedMessage,
} from "@/db/open-later";
import { useLocal } from "@/services/local-context";

type Window = MarmotWindow<MarmotConversation, "older" | "newer">;

export function useOpenLater(
  window: Window | undefined,
  snapshot: MarmotConversation | undefined,
  active: boolean,
  hidden: readonly string[],
  blockState: ReturnType<BlockedUsers["snapshot"]>,
  isFocused: () => boolean,
) {
  const { db, isCurrent, lock, privacy } = useLocal();
  const resolver = useRef<ReturnType<typeof createOpenLaterResolver>>(null);
  const [result, setResult] = useState<{
    window: Window;
    states: ReadonlyMap<string, OpenLaterState>;
  }>();

  useLayoutEffect(() => {
    if (!window || !active) return;
    const omitted = new Set(hidden);
    const instance = createOpenLaterResolver({
      read: ({ id, expiresAt }) => readOpenedMessage(db, id, expiresAt),
      save: ({ id, expiresAt }, text) =>
        saveOpenedMessage(db, id, text, expiresAt),
      allowed: ({ id, text }) => {
        const status = window.getState();
        const app = lock.getState();
        if (
          status.status !== "ready" ||
          AppState.currentState !== "active" ||
          !isFocused() ||
          !app.active ||
          app.locked ||
          !isCurrent()
        )
          return false;
        const current = status.snapshot;
        if (current.invited || !current.canSend) return false;
        return current.messages.some(
          (row) =>
            row.id === id &&
            row.text === text &&
            row.eventKind === timeLockKind &&
            !row.deleted &&
            !row.invalidationStatus &&
            !omitted.has(id) &&
            !privacy.isBlocked(row.sender),
        );
      },
      publish: (states) => setResult({ window, states }),
    });
    resolver.current = instance;
    purgeExpiredOpenedMessages(db);
    return () => {
      instance.stop();
      omitted.clear();
      resolver.current = null;
    };
  }, [active, db, hidden, isCurrent, isFocused, lock, privacy, window]);

  useLayoutEffect(() => {
    const rows = snapshot?.messages.filter(
      (row) => row.eventKind === timeLockKind,
    );
    for (const row of rows ?? []) {
      if (row.deleted || row.invalidationStatus)
        removeOpenedMessage(db, row.id);
    }
    resolver.current?.scan(rows ?? []);
  }, [active, blockState, db, hidden, snapshot, window]);

  return {
    states: active && result?.window === window ? result?.states : undefined,
    retry: (id: string) => resolver.current?.retry(id),
  };
}
