import * as Authentication from "expo-local-authentication";
import * as ScreenCapture from "expo-screen-capture";
import { Platform } from "react-native";

const legacyAndroid =
  Platform.OS === "android" && Number(Platform.Version) < 30;

export async function authenticateApp(
  operation: "enable" | "disable" | "unlock",
) {
  if (operation === "enable") {
    const level = await Authentication.getEnrolledLevelAsync();
    if (
      level === Authentication.SecurityLevel.NONE ||
      (legacyAndroid && level !== Authentication.SecurityLevel.BIOMETRIC_STRONG)
    ) {
      throw new Error(
        legacyAndroid
          ? "Enroll a supported fingerprint in system settings first."
          : "Set up biometrics or a device screen lock in system settings first.",
      );
    }
  }
  const result = await Authentication.authenticateAsync({
    promptMessage: {
      enable: "Enable App Lock",
      disable: "Turn off App Lock",
      unlock: "Unlock Boop",
    }[operation],
    biometricsSecurityLevel: "strong",
    disableDeviceFallback: legacyAndroid,
    cancelLabel: "Cancel",
  });
  if (result.success) return;
  switch (result.error) {
    case "user_cancel":
    case "app_cancel":
    case "system_cancel":
      throw new Error("Authentication canceled.");
    case "lockout":
      throw new Error(
        "Authentication is temporarily locked. Try again or use your device credential if offered.",
      );
    case "not_enrolled":
    case "not_available":
    case "passcode_not_set":
      throw new Error(
        "Check biometric and screen lock enrollment in system settings.",
      );
    default:
      throw new Error("Authentication failed. Try again.");
  }
}

export async function protectAppWindow(enabled: boolean) {
  if (Platform.OS === "ios") {
    if (enabled) await ScreenCapture.enableAppSwitcherProtectionAsync(1);
    else await ScreenCapture.disableAppSwitcherProtectionAsync();
  } else {
    if (enabled) await ScreenCapture.preventScreenCaptureAsync("boop.appLock");
    else await ScreenCapture.allowScreenCaptureAsync("boop.appLock");
  }
}
