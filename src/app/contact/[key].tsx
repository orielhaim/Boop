import { Host, Switch } from "@expo/ui";
import { router, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import {
  Action,
  Avatar,
  Card,
  Empty,
  Hero,
  Icon,
  IconButton,
  Ink,
  layout,
  Screen,
  Section,
} from "@/components/ui/kit";
import { parsePublicKey, toNpub } from "@/core/identity/keys";
import { useContact } from "@/db/contacts";
import { updateContactPreferences } from "@/db/queries";
import { directionFor, namespaces, resolveLanguage } from "@/i18n";
import { useLocal } from "@/services/local";
import { space, useTheme } from "@/theme";

export default function ContactDetail() {
  const { t, i18n } = useTranslation(namespaces);
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const params = useLocalSearchParams<{ key: string }>();
  const key =
    typeof params.key === "string" ? parsePublicKey(params.key) : null;
  const contact = useContact(key ?? "");
  const { db } = useLocal();
  const { colors, theme } = useTheme();

  if (!key)
    return (
      <Screen>
        <Empty
          icon="person"
          title={t("contacts:unavailable")}
          detail={t("contacts:invalid")}
        />
      </Screen>
    );

  const address = toNpub(key);
  if (!contact)
    return (
      <Screen>
        <Section>{t("common:address")}</Section>
        <Card style={styles.key}>
          <Ink kind="caption" selectable style={styles.address}>
            {address}
          </Ink>
        </Card>
        <Action
          onPress={() =>
            router.replace({ pathname: "/contact/new", params: { address } })
          }
        >
          {t("contacts:saveAs")}
        </Action>
      </Screen>
    );

  return (
    <Screen>
      <Hero>
        <View style={styles.profile}>
          <Avatar name={contact.name} uri={contact.avatarUrl} size="xl" />
          <Ink kind="title" accessibilityRole="header" style={styles.center}>
            {contact.name}
          </Ink>
          <IconButton
            icon={contact.favorite ? "favorite" : "star"}
            label={
              contact.favorite
                ? t("contacts:removeFavorite")
                : t("contacts:addFavorite")
            }
            onPress={() =>
              updateContactPreferences(db, contact.publicKey, {
                favorite: !contact.favorite,
              })
            }
          />
        </View>
      </Hero>
      <View style={layout.row}>
        <Action
          onPress={() =>
            router.push({
              pathname: "/call/[key]",
              params: { key: contact.publicKey },
            })
          }
        >
          <Icon name="phone" />
          {t("calls:call")}
        </Action>
        <Action
          onPress={() =>
            router.push({
              pathname: "/chat/[key]",
              params: { key: contact.publicKey },
            })
          }
        >
          <Icon name="chat" />
          {t("contacts:message")}
        </Action>
      </View>
      <Section>{t("contacts:callPermissions")}</Section>
      <Card style={styles.key}>
        <Host
          matchContents
          colorScheme={theme}
          seedColor={colors.accent}
          layoutDirection={direction === "rtl" ? "rightToLeft" : "leftToRight"}
        >
          <Switch
            label={t("video:automatic")}
            value={contact.allowIncomingVideo}
            onValueChange={(allowed) => {
              updateContactPreferences(db, key, {
                allowIncomingVideo: allowed,
              });
            }}
          />
        </Host>
      </Card>
      <Section>{t("common:address")}</Section>
      <Card style={styles.key}>
        <Ink kind="caption" selectable style={styles.address}>
          {address}
        </Ink>
      </Card>
    </Screen>
  );
}
const styles = StyleSheet.create({
  address: { writingDirection: "ltr", textAlign: "left" },
  center: { textAlign: "center" },
  profile: { alignItems: "center", gap: space.md },
  key: { padding: space.lg },
});
