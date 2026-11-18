import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { Action, Avatar, Hero, Icon, Ink, Screen } from "@/components/ui/kit";
import { useLocal } from "@/services/local";
import { space } from "@/theme";

export default function Settings() {
  const { identity } = useLocal();
  return (
    <Screen>
      <Hero>
        <View style={styles.identity}>
          <Avatar name="Boop" size="lg" />
          <Ink kind="heading">Your Boop address</Ink>
          <Ink kind="caption" muted>
            {identity.npub.slice(0, 13)}…{identity.npub.slice(-6)}
          </Ink>
          <Action
            variant="soft"
            style={styles.identityAction}
            onPress={() => router.push("/settings/identity")}
          >
            <Icon name="key" size={17} /> Identity &amp; keys
          </Action>
        </View>
      </Hero>
      <SettingsGroup title="Preferences">
        <SettingsRow
          title="Appearance"
          icon="palette"
          accent="#5B50C7"
          onPress={() => router.push("/settings/appearance")}
        />
        <SettingsRow
          title="Calls & sounds"
          icon="speaker"
          accent="#B1486C"
          onPress={() => router.push("/settings/calls")}
        />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          title="Privacy & security"
          icon="lock"
          accent="#267C65"
          onPress={() => router.push("/settings/privacy")}
        />
        <SettingsRow
          title="Connections"
          icon="connection"
          accent="#176DAB"
          onPress={() => router.push("/settings/connections")}
        />
        <SettingsRow
          title="About"
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
