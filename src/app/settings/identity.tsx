import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import {
  SettingsDescription,
  SettingsGroup,
} from "@/components/settings/group";
import { Action, Icon, Ink, Screen } from "@/components/ui/kit";
import { useLocal } from "@/services/local";
import { radius, space } from "@/theme";

export default function Identity() {
  const { qr } = useLocalSearchParams<{ qr?: string }>();
  const { identity } = useLocal();
  const [showQR, setShowQR] = useState(qr === "1");
  const [notice, setNotice] = useState("");
  const { width } = useWindowDimensions();

  async function copy() {
    try {
      if (await Clipboard.setStringAsync(identity.npub)) {
        setNotice("Address copied.");
        return;
      }
    } catch {
      // Show the same error for an unavailable clipboard.
    }
    setNotice("Could not copy the address.");
  }

  return (
    <Screen>
      <SettingsGroup title="Public address">
        <Ink selectable style={styles.key}>
          {identity.npub}
        </Ink>
      </SettingsGroup>
      <View style={styles.actions}>
        <Action variant="soft" onPress={() => void copy()}>
          <Icon name="copy" size={18} /> Copy address
        </Action>
        <Action variant="soft" onPress={() => setShowQR(true)}>
          <Icon name="qr" size={18} /> QR code
        </Action>
      </View>
      {notice && <SettingsDescription>{notice}</SettingsDescription>}
      <GlassSheet open={showQR} onOpenChange={setShowQR}>
        <GlassSheetContent>
          <GlassSheetTitle>Public address</GlassSheetTitle>
          <View
            accessible
            accessibilityLabel="QR code for your public address"
            style={styles.qr}
          >
            <QRCode
              value={`nostr:${identity.npub}`}
              size={Math.min(220, Math.max(128, width - 116))}
            />
          </View>
        </GlassSheetContent>
      </GlassSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  key: { padding: space.lg, writingDirection: "ltr" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  qr: {
    backgroundColor: "#fff",
    borderRadius: radius.input,
    alignSelf: "center",
    padding: space.lg,
    margin: space.lg,
  },
});
