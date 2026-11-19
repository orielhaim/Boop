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
      ? "nativeCallAvailable"
      : "nativeCallNoAudio";
  } catch {
    return "nativeCallUnavailable";
  }
}
