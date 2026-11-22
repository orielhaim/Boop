import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useIdentitySheet } from "@/components/people/identity-sheet";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/group";
import { Action, Icon, Ink, Screen } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";
import { space } from "@/theme";

export default function Identity() {
  const { t } = useTranslation(namespaces);
  const { identity } = useLocal();
  const chats = useChatsEnabled();
  const showSheet = useIdentitySheet();
  const [notice, setNotice] = useState("");

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
    <Screen compact>
      <SettingsGroup>
        {chats && (
          <SettingsRow
            title={t("messages:marmot.devices")}
            onPress={() => router.push("./identity/devices")}
          />
        )}
        {chats && (
          <SettingsRow
            title={t("messages:marmot.backups")}
            onPress={() => router.push("./identity/backup")}
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
        <Action variant="soft" onPress={() => showSheet("qr")}>
          <Icon name="qr" size={18} />
          {t("settings:qr")}
        </Action>
      </View>
      {notice && <SettingsDescription>{notice}</SettingsDescription>}
      <SettingsGroup>
        <SettingsRow
          icon="download"
          title={t("security:exportIdentityKey")}
          onPress={() =>
            router.push({
              pathname: "/settings/identity-keys",
              params: { mode: "export" },
            })
          }
        />
        <SettingsRow
          icon="key"
          title={t("security:importIdentityKey")}
          onPress={() => router.push("/settings/identity-keys")}
        />
      </SettingsGroup>
    </Screen>
  );
}

const styles = StyleSheet.create({
  key: { padding: space.lg, writingDirection: "ltr", textAlign: "left" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
});
