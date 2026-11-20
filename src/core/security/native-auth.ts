import * as Authentication from "expo-local-authentication";
import * as ScreenCapture from "expo-screen-capture";
import { Platform } from "react-native";

import { i18n } from "@/i18n";
import { AppAuthenticationError } from "./app-lock";

export async function authenticateApp(
  operation: "enable" | "disable" | "unlock",
) {
  if (operation === "enable") {
    const level = await Authentication.getEnrolledLevelAsync();
    if (level === Authentication.SecurityLevel.NONE) {
      throw new AppAuthenticationError("enrollDevice");
    }
  }
  const t = i18n.getFixedT(null, "security");
  const result = await Authentication.authenticateAsync({
    promptMessage: {
      enable: t("enableLockPrompt"),
      disable: t("disableLockPrompt"),
      unlock: t("unlockPrompt"),
    }[operation],
    biometricsSecurityLevel: "strong",
    disableDeviceFallback: false,
    cancelLabel: i18n.t("cancel"),
  });
  if (result.success) return;
  switch (result.error) {
    case "user_cancel":
    case "app_cancel":
    case "system_cancel":
      throw new AppAuthenticationError("authCancelled");
    case "lockout":
      throw new AppAuthenticationError("authLockout");
    case "not_enrolled":
    case "not_available":
    case "passcode_not_set":
      throw new AppAuthenticationError("authUnavailable");
    default:
      throw new AppAuthenticationError("authFailed");
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
