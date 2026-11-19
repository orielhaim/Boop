import { Camera } from "expo-camera";
import type { CameraFacing } from "./video";

export async function captureCamera({
  rtc,
  operation,
  onEnded,
  onCameraPrompt,
  waitForForeground,
}: {
  rtc: typeof import("react-native-webrtc");
  operation: AbortSignal;
  onEnded: () => void;
  onCameraPrompt: (open: boolean) => void;
  waitForForeground: (signal: AbortSignal) => Promise<void>;
}) {
  let permission = await Camera.getCameraPermissionsAsync();
  operation.throwIfAborted();
  if (!permission.granted && permission.canAskAgain) {
    onCameraPrompt(true);
    try {
      permission = await Camera.requestCameraPermissionsAsync();
      await waitForForeground(operation);
    } finally {
      onCameraPrompt(false);
    }
  }
  operation.throwIfAborted();
  if (!permission.granted) throw new Error("camera-permission");
  const constraints = { width: 640, height: 480, frameRate: 24 };
  const stream = await rtc.mediaDevices.getUserMedia({
    audio: false,
    video: { ...constraints, facingMode: "user" },
  });
  const track = stream.getVideoTracks()[0];
  if (!track || operation.aborted) {
    for (const item of stream.getTracks()) item.stop();
    stream.release();
    throw new Error("Camera unavailable");
  }
  track.onended = onEnded;
  return {
    stream: stream as unknown as MediaStream,
    url: stream.toURL(),
    stop() {
      track.onended = null;
      track.enabled = false;
      track.stop();
    },
    release: () => stream.release(),
    async switchTo(facing: CameraFacing) {
      const facingMode = facing === "front" ? "user" : "environment";
      await track.applyConstraints({ ...constraints, facingMode });
      if (track.getSettings().facingMode !== facingMode)
        throw new Error("Requested camera unavailable");
    },
  };
}
