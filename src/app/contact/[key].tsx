import { AvatarPicker } from "@/components/avatars/picker";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/group";
import { Host, Switch } from "@expo/ui";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
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
import { useBlockAction } from "@/components/ui/privacy-actions";
import { parsePublicKey, toNpub } from "@/core/identity/keys";
import { useContact } from "@/db/contacts";
import { updateContactPreferences } from "@/db/queries";
import { directionFor, namespaces, resolveLanguage } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local";
import { space, useTheme } from "@/theme";

export default function ContactDetail() {
  const { t, i18n } = useTranslation(namespaces);
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const params = useLocalSearchParams<{ key: string }>();
  const key =
    typeof params.key === "string" ? parsePublicKey(params.key) : null;
  const contact = useContact(key ?? "");
  const { db, avatars } = useLocal();
  const block = useBlockAction(key ?? "");
  const chatsEnabled = useChatsEnabled();
  const [showQr, setShowQr] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [notice, setNotice] = useState("");
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
  const keyActions = (
    <>
      <Action onPress={() => setShowQr((shown) => !shown)}>
        {t("security:showIdentityQr")}
      </Action>
      {showQr && (
        <View
          style={styles.qr}
          accessible
          accessibilityLabel={t("settings:addressQr")}
        >
          <QRCode value={`nostr:${address}`} size={180} />
        </View>
      )}
      <Action onPress={block.onPress}>{block.label}</Action>
    </>
  );
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
        {keyActions}
      </Screen>
    );

  if (selecting)
    return (
      <Screen scroll={false}>
        <View style={styles.editor}>
          <AvatarPicker
            onCancel={() => setSelecting(false)}
            onSave={(file) => {
              avatars.saveOverride(key, file.uri);
              setSelecting(false);
            }}
          />
        </View>
      </Screen>
    );
  return (
    <Screen>
      <Hero>
        <View style={styles.profile}>
          <Avatar name={contact.name} publicKey={contact.publicKey} size="xl" />
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
          disabled={block.blocked}
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
        {chatsEnabled && (
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
        )}
      </View>
      {!block.blocked && (
        <SettingsGroup title={t("settings:photoLocal")}>
          <SettingsRow
            title={t("settings:photoChange")}
            detail={t("settings:photoLocalHelp")}
            onPress={() => setSelecting(true)}
          />
          {avatars.hasOverride(key) && (
            <SettingsRow
              title={t("settings:photoRemove")}
              onPress={() => {
                try {
                  avatars.saveOverride(key, null);
                } catch {
                  setNotice(t("security:privacyWriteFailed"));
                }
              }}
            />
          )}
        </SettingsGroup>
      )}
      {notice && <SettingsDescription>{notice}</SettingsDescription>}
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
      {keyActions}
    </Screen>
  );
}
const styles = StyleSheet.create({
  editor: { flex: 1, justifyContent: "center", paddingHorizontal: space.xl },
  qr: { backgroundColor: "#fff", padding: space.md, alignSelf: "center" },
  address: { writingDirection: "ltr", textAlign: "left" },
  center: { textAlign: "center" },
  profile: { alignItems: "center", gap: space.md },
  key: { padding: space.lg },
});
