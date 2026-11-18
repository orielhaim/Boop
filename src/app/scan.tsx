import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useIsFocused, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { Action, Empty, Ink, Screen } from "@/components/ui/kit";
import { parsePublicKey, toNpub } from "@/core/identity/keys";
import { useLocal } from "@/services/local";
import { radius, space, useTheme } from "@/theme";

export default function ScanAddress() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const { identity } = useLocal();
  const focused = useIsFocused();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState("");
  const locked = useRef(false);
  const { colors } = useTheme();

  if (!permission?.granted)
    return (
      <Screen>
        <Empty
          icon="qr"
          title="Scan a Boop address"
          detail="Allow camera access to scan an address."
        >
          <Action
            onPress={() => {
              if (permission?.canAskAgain === false)
                void Linking.openSettings();
              else
                void requestPermission().catch(() =>
                  setError("Could not request camera access."),
                );
            }}
          >
            {permission?.canAskAgain === false
              ? "Open device settings"
              : "Allow camera"}
          </Action>
        </Empty>
        {error ? <Ink accessibilityLiveRegion="polite">{error}</Ink> : null}
      </Screen>
    );

  return (
    <Screen>
      <View style={styles.preview}>
        {focused ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onMountError={() =>
              setError(
                "Could not open the camera. You can enter the address manually.",
              )
            }
            onBarcodeScanned={({ data }) => {
              if (locked.current) return;
              const key = parsePublicKey(data);
              if (!key) {
                setError("This QR code does not contain a Boop address.");
                return;
              }
              if (key === identity.publicKey) {
                setError("Scan someone else’s address.");
                return;
              }
              locked.current = true;
              if (mode === "chat" || mode === "call") {
                router.replace({
                  pathname: mode === "call" ? "/call/[key]" : "/chat/[key]",
                  params: { key },
                });
                return;
              }
              router.dismissTo({
                pathname: "/contact/new",
                params: { address: toNpub(key) },
              });
            }}
          />
        ) : null}
        <View
          pointerEvents="none"
          style={[styles.target, { borderColor: colors.outgoingInk }]}
        />
      </View>
      <Ink accessibilityLiveRegion="polite" style={styles.hint} muted>
        {error || "Position the QR code inside the frame."}
      </Ink>
    </Screen>
  );
}

const styles = StyleSheet.create({
  preview: {
    aspectRatio: 1,
    borderRadius: radius.card,
    overflow: "hidden",
    backgroundColor: "#111827",
    alignItems: "center",
    justifyContent: "center",
  },
  target: {
    width: "65%",
    aspectRatio: 1,
    borderWidth: 2,
    borderRadius: radius.input,
  },
  hint: { paddingHorizontal: space.sm, textAlign: "center" },
});
