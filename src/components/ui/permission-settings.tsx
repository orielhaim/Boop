import { useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
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

const showsBluetooth = Platform.OS === "android" && Platform.Version >= 31;
type Status = "Allowed" | "Not allowed" | "Not requested" | "Unavailable";

async function permissionStatus(
  check: () => Promise<{ status: string }>,
): Promise<Status> {
  try {
    switch ((await check()).status) {
      case "granted":
        return "Allowed";
      case "denied":
        return "Not allowed";
      case "undetermined":
        return "Not requested";
      default:
        return "Unavailable";
    }
  } catch {
    return "Unavailable";
  }
}

async function bluetoothStatus(): Promise<Status> {
  try {
    return (await hasBluetoothOutputPermission()) ? "Allowed" : "Not allowed";
  } catch {
    return "Unavailable";
  }
}

export function PermissionSettings() {
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
          title="Camera"
          icon="camera"
          value={camera ?? "Checking…"}
        />
        <SettingsRow
          title="Microphone"
          icon="microphone"
          value={microphone ?? "Checking…"}
        />
        {showsBluetooth && (
          <SettingsRow
            title="Nearby devices"
            icon="audio"
            value={
              bluetooth === "Not allowed"
                ? undefined
                : (bluetooth ?? "Checking…")
            }
            trailing={
              bluetooth === "Not allowed" && (
                <Action
                  size="sm"
                  variant="soft"
                  disabled={requesting}
                  accessibilityLabel="Allow nearby devices"
                  onPress={async () => {
                    setRequesting(true);
                    setNotice("");
                    try {
                      const allowed = await allowBluetoothOutput();
                      setBluetooth(allowed ? "Allowed" : "Not allowed");
                      if (!allowed)
                        setNotice(
                          "You can change Nearby devices access in system settings.",
                        );
                    } catch {
                      setNotice("Could not request Bluetooth access.");
                    } finally {
                      setRequesting(false);
                    }
                  }}
                >
                  Allow
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
            setNotice("Could not open system settings.");
          }
        }}
      >
        Open system settings
      </Action>
      {notice && <SettingsDescription>{notice}</SettingsDescription>}
    </>
  );
}

const styles = StyleSheet.create({
  settings: { alignSelf: "flex-start" },
});
