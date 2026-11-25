import { createContext } from "react";
import type { DialogQueue } from "./dialog-queue";

export type DialogAccess = {
  read(): boolean;
  subscribe(listener: () => void): () => void;
};

// A stable context identity when the dialog UI refreshes in development.
export const DialogAccessContext = createContext<DialogAccess>({
  read: () => true,
  subscribe: () => () => {},
});

export const DialogQueueContext = createContext<{
  queue: DialogQueue;
  windowOwner: ReturnType<typeof createDialogOwner>;
} | null>(null);

export function createDialogOwner(canPresent: () => boolean) {
  let controller = new AbortController();
  return {
    get signal() {
      return controller.signal;
    },
    canPresent,
    activate() {
      if (controller.signal.aborted) controller = new AbortController();
    },
    revoke() {
      controller.abort();
    },
  };
}
