import { ScreenHeader } from "@/components/navigation/screen-header";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIdentitySheet } from "@/components/people/identity-sheet";
import {
  SettingsDescription,
  ListGroup,
  ListRow,
} from "@/components/ui/list-group";
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
    <Screen
      compact
      navigationHeader={<ScreenHeader title={t("settings:identity")} />}
    >
      <ListGroup>
        {chats && (
          <ListRow
            title={t("messages:marmot.devices")}
            onPress={() => router.push("./identity/devices")}
          />
        )}
        {chats && (
          <ListRow
            title={t("messages:marmot.backups")}
            onPress={() => router.push("./identity/backup")}
          />
        )}
      </ListGroup>
      <ListGroup title={t("settings:publicAddress")}>
        <Ink selectable style={styles.key}>
          {identity.npub}
        </Ink>
      </ListGroup>
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
      <ListGroup>
        <ListRow
          icon="download"
          title={t("security:exportIdentityKey")}
          onPress={() =>
            router.push({
              pathname: "/settings/identity-keys",
              params: { mode: "export" },
            })
          }
        />
        <ListRow
          icon="key"
          title={t("security:importIdentityKey")}
          onPress={() => router.push("/settings/identity-keys")}
        />
      </ListGroup>
    </Screen>
  );
}

const styles = StyleSheet.create({
  key: { padding: space.lg, writingDirection: "ltr", textAlign: "left" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
});
