import type { CallInvitation, PeerChallenge } from "./protocol";

export interface PendingCallPeer {
  readonly remotePeerId: string;
  readonly localPeerId: string;
  prove(challenge: PeerChallenge, signal: AbortSignal): Promise<unknown>;
  startAudio(signal: AbortSignal): Promise<void>;
  onDisconnect(listener: () => void): () => void;
  setMuted(muted: boolean): void;
  setSpeaker(speaker: boolean): void;
  close(): void;
}

export interface CallTransport {
  connect(
    invitation: CallInvitation,
    signal: AbortSignal,
  ): Promise<PendingCallPeer>;
}

export const callingUnavailable =
  "Peer-to-peer calling is unavailable in this build.";

export const trysteroTransport: CallTransport = {
  async connect() {
    throw new Error(callingUnavailable);
  },
};

export function missingTrysteroCapabilities(runtime: {
  crypto?: { subtle?: object; getRandomValues?: unknown; randomUUID?: unknown };
  RTCPeerConnection?: unknown;
  WebSocket?: unknown;
  TextEncoder?: unknown;
  TextDecoder?: unknown;
}) {
  const missing: string[] = [];
  if (!runtime.crypto?.subtle) missing.push("WebCrypto SubtleCrypto");
  if (typeof runtime.crypto?.getRandomValues !== "function")
    missing.push("crypto.getRandomValues");
  if (typeof runtime.crypto?.randomUUID !== "function")
    missing.push("crypto.randomUUID");
  if (typeof runtime.RTCPeerConnection !== "function")
    missing.push("RTCPeerConnection");
  if (typeof runtime.WebSocket !== "function") missing.push("WebSocket");
  if (typeof runtime.TextEncoder !== "function") missing.push("TextEncoder");
  if (typeof runtime.TextDecoder !== "function") missing.push("TextDecoder");
  return missing;
}
