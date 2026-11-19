import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { Action, Avatar, Hero, Icon, Ink, Screen } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { isolateText } from "@/i18n/format";
import { useLocal } from "@/services/local";
import { space } from "@/theme";

export default function Settings() {
  const { t } = useTranslation(namespaces);
  const { identity } = useLocal();
  return (
    <Screen>
      <Hero>
        <View style={styles.identity}>
          <Avatar name="Boop" size="lg" />
          <Ink kind="heading">{t("settings:yourAddress")}</Ink>
          <Ink kind="caption" muted>
            {isolateText(
              `${identity.npub.slice(0, 13)}…${identity.npub.slice(-6)}`,
            )}
          </Ink>
          <Action
            variant="soft"
            style={styles.identityAction}
            onPress={() => router.push("/settings/identity")}
          >
            <Icon name="key" size={17} /> {t("settings:identity")}
          </Action>
        </View>
      </Hero>
      <SettingsGroup title={t("settings:preferences")}>
        <SettingsRow
          title={t("common:chats")}
          icon="chat"
          accent="#347E76"
          onPress={() => router.push("/settings/chats")}
        />
        <SettingsRow
          title={t("settings:appearance")}
          icon="palette"
          accent="#5B50C7"
          onPress={() => router.push("/settings/appearance")}
        />
        <SettingsRow
          title={t("settings:calls")}
          icon="speaker"
          accent="#B1486C"
          onPress={() => router.push("/settings/calls")}
        />
        <SettingsRow
          title={t("settings:language")}
          icon="language"
          accent="#366F98"
          onPress={() => router.push("/settings/language")}
        />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          title={t("settings:privacy")}
          icon="lock"
          accent="#267C65"
          onPress={() => router.push("/settings/privacy")}
        />
        <SettingsRow
          title={t("settings:connections")}
          icon="connection"
          accent="#176DAB"
          onPress={() => router.push("/settings/connections")}
        />
        <SettingsRow
          title={t("settings:about")}
          icon="info"
          accent="#51617D"
          onPress={() => router.push("/settings/about")}
        />
      </SettingsGroup>
    </Screen>
  );
}

const styles = StyleSheet.create({
  identityAction: { alignSelf: "center", marginTop: space.xs },
  identity: { alignItems: "center", gap: space.sm },
});
