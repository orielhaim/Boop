import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useIsFocused } from "expo-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, View } from "react-native";
import { Action, Empty, Ink, Screen } from "@/components/ui/kit";
import { parsePublicIdentity } from "@/core/identity/keys";
import { namespaces } from "@/i18n";
import { radius, space, useTheme } from "@/theme";

export default function ScanAddress() {
  const { t } = useTranslation(namespaces);
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
          title={t("contacts:scanTitle")}
          detail={t("contacts:cameraAccess")}
        >
          <Action
            onPress={() => {
              if (permission?.canAskAgain === false)
                void Linking.openSettings();
              else
                void requestPermission().catch(() =>
                  setError(t("contacts:requestCameraError")),
                );
            }}
          >
            {permission?.canAskAgain === false
              ? t("common:openDeviceSettings")
              : t("contacts:allowCamera")}
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
            onMountError={() => setError(t("contacts:cameraUnavailable"))}
            onBarcodeScanned={({ data }) => {
              if (locked.current) return;
              const result = parsePublicIdentity(data);
              const key = result?.key;
              if (!key) {
                setError(t("contacts:invalidQr"));
                return;
              }
              locked.current = true;
              router.replace({
                pathname: "/person/[key]",
                params: { key, reference: data },
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
        {error || t("contacts:scanHint")}
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
