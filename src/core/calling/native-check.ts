import { NativeModules } from "react-native";
import { missingTrysteroCapabilities } from "./transport";

export async function checkNativeCalling() {
  let webRTC = "Native WebRTC could not create a local peer connection.";
  let peerConnectionClass: unknown;
  try {
    const { RTCPeerConnection } = await import("react-native-webrtc");
    peerConnectionClass = RTCPeerConnection;
    const peer = new RTCPeerConnection({ iceServers: [] });
    peer.close();
    webRTC = "Native WebRTC opened and closed a local peer connection.";
  } catch {
    // Keep native exception details out of this diagnostic screen.
  }

  const missing = missingTrysteroCapabilities({
    crypto: globalThis.crypto,
    RTCPeerConnection: peerConnectionClass,
    WebSocket: globalThis.WebSocket,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
  });
  return [
    webRTC,
    typeof NativeModules.InCallManager?.start === "function"
      ? "InCallManager is linked. Audio routing remains untested."
      : "InCallManager is unavailable.",
    missing.length > 0
      ? `Missing Trystero APIs: ${missing.join(", ")}.`
      : "Required API names are present. Trystero rooms and audio still need device testing.",
  ].join("\n");
}
