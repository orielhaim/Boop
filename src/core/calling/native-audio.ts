import { DeviceEventEmitter, Platform } from "react-native";
import InCallManager from "react-native-incall-manager";
import { z } from "zod";
import { useAppPreferences } from "@/stores/preferences";
import { type AudioRoute, audioRoute, type Routing } from "./controller";

const nativeRouting = z.object({
  availableAudioDeviceList: z.string(),
  selectedAudioDevice: z.string(),
});

let tone: "incoming" | "ringing" | "silent" = "silent";
const vibrationPattern = [
  0,
  ...Array.from({ length: 18 }, () => [650, 1350]).flat(),
];

export function callTone(mode: typeof tone) {
  if (mode === tone) return;
  if (tone === "incoming") InCallManager.stopRingtone();
  if (tone === "ringing") InCallManager.stopRingback();
  tone = mode;
  if (mode === "incoming") {
    const android = Platform.OS === "android";
    InCallManager.startRingtone(
      android ? "_DEFAULT_" : "_BUNDLE_",
      android && useAppPreferences.getState().haptics ? vibrationPattern : 0,
      "default",
      35,
    );
  }
  if (mode === "ringing") InCallManager.startRingback("_BUNDLE_");
}

export function openCallAudio(
  onRouting: (routes: Routing) => void,
  onFocusLoss: () => void,
) {
  let closed = false;
  const update = (data: unknown) => {
    const parsed = nativeRouting.safeParse(data);
    if (closed || !parsed.success) return;
    try {
      const available = z
        .array(audioRoute)
        .parse(JSON.parse(parsed.data.availableAudioDeviceList));
      const selected =
        audioRoute.safeParse(parsed.data.selectedAudioDevice).data ?? null;
      onRouting({ selected, available });
    } catch {
      // Ignore incomplete routing notifications from the native bridge.
    }
  };
  const changes = DeviceEventEmitter.addListener(
    "onAudioDeviceChanged",
    update,
  );
  const focus = DeviceEventEmitter.addListener(
    "onAudioFocusChange",
    (event: unknown) => {
      const parsed = z.object({ eventCode: z.number() }).safeParse(event);
      if (!closed && parsed.success && parsed.data.eventCode < 0) onFocusLoss();
    },
  );
  InCallManager.start({ media: "audio", auto: true });
  if (Platform.OS === "ios") {
    onRouting({ available: ["SPEAKER_PHONE", "EARPIECE"], selected: null });
  }
  return {
    async route(value: AudioRoute) {
      if (closed) return;
      if (Platform.OS === "android") {
        update(await InCallManager.chooseAudioRoute(value));
      } else if (Platform.OS === "ios") {
        // Releasing the speaker override lets AVAudioSession choose the route.
        InCallManager.setForceSpeakerphoneOn(value === "SPEAKER_PHONE");
        onRouting({ available: ["EARPIECE", "SPEAKER_PHONE"], selected: null });
      }
    },
    close() {
      if (closed) return;
      closed = true;
      changes.remove();
      focus.remove();
      InCallManager.stop();
    },
  };
}
