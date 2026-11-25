import type { MarmotWindow, marmot } from "@/core/marmot/native";
import type { MarmotDownload } from "@/core/downloads/types";
import { acceptedAttachments } from "@/core/marmot/message-projection";

type AuthorityWindow = Pick<
  MarmotWindow<{ authorityReady: boolean }, never>,
  "getState" | "subscribe"
>;

type ConversationState = ReturnType<
  Awaited<ReturnType<typeof marmot.openConversation>>["getState"]
>;

export function authorizedMarmotAttachment(
  state: ConversationState | undefined,
  source: Pick<MarmotDownload, "target" | "sender">,
  blocked: (sender: string) => boolean,
) {
  if (state?.status !== "ready") return;
  const { snapshot } = state;
  if (
    !snapshot.authorityReady ||
    snapshot.invited ||
    !snapshot.canSend ||
    (snapshot.peer && blocked(snapshot.peer)) ||
    blocked(source.sender)
  )
    return;
  const [, message, event, index] = source.target;
  return snapshot.messages.find(
    (row) =>
      row.id === message &&
      row.sourceId === event &&
      row.sender === source.sender &&
      !row.deleted &&
      !row.invalidationStatus &&
      (row.expiresAt == null || row.expiresAt * 1000 > Date.now()) &&
      acceptedAttachments(row).some((attachment) => attachment.index === index),
  );
}

export function waitForMediaAuthority(
  window: AuthorityWindow,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    function finish(error?: unknown) {
      clearTimeout(timeout);
      unsubscribe();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    function abort() {
      finish(signal.reason ?? new Error("AudioUnavailable"));
    }
    function check() {
      const state = window.getState();
      if (signal.aborted) abort();
      else if (state.status === "closed") finish(new Error("AudioUnavailable"));
      else if (state.snapshot.authorityReady) finish();
    }
    const timeout = setTimeout(
      () => finish(new Error("AudioUnavailable")),
      5_000,
    );
    const unsubscribe = window.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}
