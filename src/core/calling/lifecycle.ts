import { type CallInvitation, opaqueId, verifyPeerProof } from "./protocol";
import type { CallTransport, PendingCallPeer } from "./transport";

export type CallState =
  | { phase: "idle" }
  | {
      phase:
        "outgoing" | "incoming" | "ringing" | "connecting" | "ended" | "failed";
    }
  | { phase: "active"; startedAt: number };

export class CallSession {
  #controller = new AbortController();
  #peer: PendingCallPeer | undefined;
  #unsubscribe: (() => void) | undefined;
  #timeout: ReturnType<typeof setTimeout> | undefined;
  #state: CallState = { phase: "idle" };
  #direction: "incoming" | "outgoing" | undefined;

  constructor(private readonly changed: (state: CallState) => void) {}

  get state() {
    return this.#state;
  }

  start(direction: "incoming" | "outgoing") {
    if (this.#state.phase !== "idle") return;
    this.#direction = direction;
    this.#set({ phase: direction });
    if (this.#controller.signal.aborted) return;
    this.#timeout = setTimeout(() => this.finish("failed"), 30_000);
    this.#set({ phase: "ringing" });
  }

  async accept(
    transport: CallTransport,
    invitation: CallInvitation,
    localKey: string,
    expectedKey: string,
    randomChallenge: () => Promise<string>,
  ) {
    if (this.#state.phase !== "ringing") return;
    const [caller, recipient] =
      this.#direction === "incoming"
        ? [expectedKey, localKey]
        : [localKey, expectedKey];
    if (
      caller === recipient ||
      invitation.caller !== caller ||
      invitation.recipient !== recipient ||
      Date.now() >= invitation.expiresAt
    ) {
      this.finish("failed");
      return;
    }
    const { signal } = this.#controller;
    this.#set({ phase: "connecting" });
    try {
      signal.throwIfAborted();
      const peer = await transport.connect(invitation, signal);
      if (signal.aborted) {
        peer.close();
        return;
      }
      this.#peer = peer;
      const unsubscribe = peer.onDisconnect(() => this.finish("ended"));
      if (signal.aborted) {
        unsubscribe();
        return;
      }
      this.#unsubscribe = unsubscribe;
      signal.throwIfAborted();
      const challenge = await randomChallenge();
      signal.throwIfAborted();
      if (!opaqueId.safeParse(challenge).success) {
        this.finish("failed");
        return;
      }
      const session = {
        callId: invitation.callId,
        challenge,
        localKey,
        expectedKey,
        remotePeerId: peer.remotePeerId,
        localPeerId: peer.localPeerId,
      };
      const proof = await peer.prove(session, signal);
      signal.throwIfAborted();
      if (
        Date.now() >= invitation.expiresAt ||
        !verifyPeerProof(proof, session, Math.floor(Date.now() / 1000))
      ) {
        this.finish("failed");
        return;
      }
      await peer.startAudio(signal);
      signal.throwIfAborted();
      clearTimeout(this.#timeout);
      this.#set({ phase: "active", startedAt: Date.now() });
    } catch {
      if (!signal.aborted) this.finish("failed");
    }
  }

  mute(value: boolean) {
    if (this.#state.phase === "active") this.#peer?.setMuted(value);
  }
  speaker(value: boolean) {
    if (this.#state.phase === "active") this.#peer?.setSpeaker(value);
  }

  finish(phase: "ended" | "failed" = "ended") {
    if (this.#controller.signal.aborted) return;
    this.#controller.abort();
    clearTimeout(this.#timeout);
    const unsubscribe = this.#unsubscribe;
    const peer = this.#peer;
    this.#unsubscribe = undefined;
    this.#peer = undefined;
    try {
      unsubscribe?.();
    } finally {
      try {
        peer?.close();
      } finally {
        this.#set({ phase });
      }
    }
  }

  #set(state: CallState) {
    this.#state = state;
    this.changed(state);
  }
}
