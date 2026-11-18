import { NativeModules } from "react-native";
import { initializeCallingRuntime } from "./trystero";

export async function checkNativeCalling() {
  try {
    const { RTCPeerConnection } = await initializeCallingRuntime();
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new Uint8Array([1]),
    );
    if (digest.byteLength !== 32) throw new Error("Unexpected SHA-256 length");
    const connection = new RTCPeerConnection({ iceServers: [] });
    connection.close();
    return typeof NativeModules.InCallManager?.start === "function"
      ? "WebCrypto SHA-256, local WebRTC, and InCallManager are available."
      : "WebCrypto and local WebRTC are available. Native call audio is missing.";
  } catch {
    return "The local WebCrypto or WebRTC runtime could not start.";
  }
}
