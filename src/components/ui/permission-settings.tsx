import { useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Linking, Platform, StyleSheet } from "react-native";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/group";
import { Action } from "@/components/ui/kit";
import {
  allowBluetoothOutput,
  hasBluetoothOutputPermission,
} from "@/core/calling/permissions";
import { namespaces } from "@/i18n";

const showsBluetooth = Platform.OS === "android";
type Status = "granted" | "denied" | "undetermined" | "unavailable";

async function permissionStatus(
  check: () => Promise<{ status: string }>,
): Promise<Status> {
  try {
    switch ((await check()).status) {
      case "granted":
        return "granted";
      case "denied":
        return "denied";
      case "undetermined":
        return "undetermined";
      default:
        return "unavailable";
    }
  } catch {
    return "unavailable";
  }
}

async function bluetoothStatus(): Promise<Status> {
  try {
    return (await hasBluetoothOutputPermission()) ? "granted" : "denied";
  } catch {
    return "unavailable";
  }
}

export function PermissionSettings() {
  const { t } = useTranslation(namespaces);
  const label = (status?: Status) =>
    !status
      ? t("common:checking")
      : status === "unavailable"
        ? t("common:unavailable")
        : t(`security:${status}`);
  const [, , getCameraPermission] = useCameraPermissions({ get: false });
  const [, , getMicPermission] = useMicrophonePermissions({ get: false });
  const [camera, setCamera] = useState<Status>();
  const [microphone, setMicrophone] = useState<Status>();
  const [bluetooth, setBluetooth] = useState<Status>();
  const [notice, setNotice] = useState("");
  const [requesting, setRequesting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let focused = true;
      let refreshId = 0;
      const refresh = async () => {
        const id = ++refreshId;
        const [cameraStatus, microphoneStatus, nearbyStatus] =
          await Promise.all([
            permissionStatus(getCameraPermission),
            permissionStatus(getMicPermission),
            showsBluetooth ? bluetoothStatus() : undefined,
          ]);
        if (!focused || id !== refreshId) return;
        setCamera(cameraStatus);
        setMicrophone(microphoneStatus);
        setBluetooth(nearbyStatus);
      };
      void refresh();
      const listener = AppState.addEventListener("change", (state) => {
        if (state === "active") void refresh();
      });
      return () => {
        focused = false;
        listener.remove();
      };
    }, [getCameraPermission, getMicPermission]),
  );

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          title={t("common:camera")}
          icon="camera"
          value={label(camera)}
        />
        <SettingsRow
          title={t("common:microphone")}
          icon="microphone"
          value={label(microphone)}
        />
        {showsBluetooth && (
          <SettingsRow
            title={t("security:nearby")}
            icon="audio"
            value={bluetooth === "denied" ? undefined : label(bluetooth)}
            trailing={
              bluetooth === "denied" && (
                <Action
                  size="sm"
                  variant="soft"
                  disabled={requesting}
                  accessibilityLabel={t("security:allowNearby")}
                  onPress={async () => {
                    setRequesting(true);
                    setNotice("");
                    try {
                      const allowed = await allowBluetoothOutput();
                      setBluetooth(allowed ? "granted" : "denied");
                      if (!allowed) setNotice(t("security:nearbyHint"));
                    } catch {
                      setNotice(t("security:bluetoothError"));
                    } finally {
                      setRequesting(false);
                    }
                  }}
                >
                  {t("security:allow")}
                </Action>
              )
            }
          />
        )}
      </SettingsGroup>
      <Action
        variant="soft"
        style={styles.settings}
        onPress={async () => {
          try {
            await Linking.openSettings();
            setNotice("");
          } catch {
            setNotice(t("security:openSettingsError"));
          }
        }}
      >
        {t("common:openDeviceSettings")}
      </Action>
      {notice && <SettingsDescription>{notice}</SettingsDescription>}
    </>
  );
}

const styles = StyleSheet.create({
  settings: { alignSelf: "flex-start" },
});
