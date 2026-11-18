import { useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { AppState, Linking, Platform, StyleSheet, View } from "react-native";
import { Action, Card, Ink, Row } from "@/components/ui/kit";
import {
  allowBluetoothOutput,
  hasBluetoothOutputPermission,
} from "@/core/calling/permissions";
import { space } from "@/theme";

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
    <Card>
      <Row
        title="Camera"
        detail={`${camera ?? "Checking…"} · Scan addresses and share your camera on calls`}
      />
      <Row
        title="Microphone"
        detail={`${microphone ?? "Checking…"} · Voice calls`}
      />
      {showsBluetooth && (
        <Row
          title="Nearby devices"
          detail={`${bluetooth ?? "Checking…"} · Bluetooth headsets`}
          trailing={
            bluetooth === "Not allowed" && (
              <Action
                size="sm"
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
      <View style={styles.footer}>
        <Action
          size="sm"
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
        {notice ? (
          <Ink kind="caption" accessibilityLiveRegion="polite">
            {notice}
          </Ink>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  footer: { alignItems: "flex-start", gap: space.sm, padding: space.lg },
});
