import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
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
  SettingsRow,
} from "@/components/settings/group";
import { Action, Icon, Ink, Screen } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";
import { radius, space } from "@/theme";

export default function Identity() {
  const { t } = useTranslation(namespaces);
  const { qr } = useLocalSearchParams<{ qr?: string }>();
  const { identity } = useLocal();
  const chats = useChatsEnabled();
  const [showQR, setShowQR] = useState(qr === "1");
  const [notice, setNotice] = useState("");
  const { width } = useWindowDimensions();

  async function copy() {
    try {
      if (await Clipboard.setStringAsync(identity.npub)) {
        setNotice(t("settings:addressCopied"));
        return;
      }
    } catch {
      // Show the same error for an unavailable clipboard.
    }
    setNotice(t("settings:copyAddressError"));
  }

  return (
    <Screen>
      <SettingsGroup>
        <SettingsRow
          title={t("settings:editProfile")}
          onPress={() => router.push("/settings/identity/edit-profile")}
        />
        {chats && (
          <SettingsRow
            title={t("messages:marmot.devices")}
            onPress={() => router.push("./identity/devices")}
          />
        )}
      </SettingsGroup>
      <SettingsGroup title={t("settings:publicAddress")}>
        <Ink selectable style={styles.key}>
          {identity.npub}
        </Ink>
      </SettingsGroup>
      <View style={styles.actions}>
        <Action variant="soft" onPress={() => void copy()}>
          <Icon name="copy" size={18} />
          {t("settings:copyAddress")}
        </Action>
        <Action variant="soft" onPress={() => setShowQR(true)}>
          <Icon name="qr" size={18} />
          {t("settings:qr")}
        </Action>
      </View>
      {notice && <SettingsDescription>{notice}</SettingsDescription>}
      <View style={styles.actions}>
        <Action
          onPress={() =>
            router.push({
              pathname: "./sim",
              params: { mode: "export" },
            })
          }
        >
          {t("security:exportSim")}
        </Action>
        <Action onPress={() => router.push("./sim")}>
          {t("security:importSim")}
        </Action>
      </View>
      <GlassSheet open={showQR} onOpenChange={setShowQR}>
        <GlassSheetContent>
          <GlassSheetTitle>{t("settings:publicAddress")}</GlassSheetTitle>
          <View
            accessible
            accessibilityLabel={t("settings:addressQr")}
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
  key: { padding: space.lg, writingDirection: "ltr", textAlign: "left" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  qr: {
    backgroundColor: "#fff",
    borderRadius: radius.input,
    alignSelf: "center",
    padding: space.lg,
    margin: space.lg,
  },
});
