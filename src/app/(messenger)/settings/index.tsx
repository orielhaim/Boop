import { router } from "expo-router";
import { useSyncExternalStore } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { PersonAvatar } from "@/components/people/person-avatar";
import { usePerson } from "@/components/people/use-person";
import { backButtonSize, GlassBackButton } from "@/components/ui/back-button";
import { Icon, Ink, Screen, tapFeedback } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { radius, space, useTheme } from "@/theme";

export default function Settings() {
  const { t } = useTranslation(namespaces);
  const { identity, profileEditor } = useLocal();
  const {
    photo: publishedPhoto,
    name,
    profile,
  } = usePerson(identity.publicKey);
  const { draft, photoPreview } = useSyncExternalStore(
    profileEditor.subscribe,
    profileEditor.getSnapshot,
  );
  const displayName = draft?.name || name;
  const photo =
    draft?.photo.kind === "remove"
      ? undefined
      : (photoPreview ?? publishedPhoto);
  const { colors } = useTheme();
  const edit = () => router.push("/settings/edit-profile");
  return (
    <Screen compact topInset>
      <View style={styles.profileRow}>
        <GlassBackButton
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/profile");
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t("settings:editProfile")}, ${displayName}`}
          onPress={() => {
            tapFeedback();
            edit();
          }}
          style={({ pressed }) => [
            styles.identity,
            pressed && { opacity: 0.72 },
          ]}
        >
          <View style={styles.avatar}>
            <PersonAvatar
              size="xl"
              publicKey={identity.publicKey}
              name={displayName}
              photo={photo}
              hasName={Boolean(profile?.name || draft?.name)}
            />
            <View
              style={[
                styles.edit,
                {
                  backgroundColor: colors.outgoing,
                  borderColor: colors.background,
                },
              ]}
            >
              <Icon name="edit" size={14} color={colors.outgoingInk} />
            </View>
          </View>
          <Ink
            kind="heading"
            numberOfLines={2}
            style={[
              styles.name,
              !profile?.name && !draft?.name && styles.address,
            ]}
          >
            {displayName}
          </Ink>
          <Ink kind="caption" style={{ color: colors.accent }}>
            {t("settings:editProfile")}
          </Ink>
        </Pressable>
      </View>
      <SettingsGroup>
        <SettingsRow
          title={t("settings:appearance")}
          icon="palette"
          accent="#347E76"
          onPress={() => router.push("/settings/appearance")}
        />
        <SettingsRow
          title={t("settings:calls")}
          icon="speaker"
          accent="#B1486C"
          onPress={() => router.push("/settings/calls")}
        />
        <SettingsRow
          title={t("audio:settings")}
          icon="audio"
          onPress={() => router.push("/settings/playback")}
        />
        <SettingsRow
          title={t("storage:title")}
          icon="storage"
          accent="#5263A6"
          onPress={() => router.push("/settings/storage")}
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
          title={t("settings:identity")}
          icon="key"
          onPress={() => router.push("/settings/identity")}
        />
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
      </SettingsGroup>
      <SettingsGroup>
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
  profileRow: { flexDirection: "row", alignItems: "flex-start" },
  identity: {
    flex: 1,
    marginEnd: backButtonSize,
    alignItems: "center",
    paddingBottom: space.sm,
    gap: space.sm,
  },
  avatar: { marginBottom: space.xs },
  edit: {
    position: "absolute",
    bottom: -2,
    end: -2,
    width: 28,
    height: 28,
    borderRadius: radius.round,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { textAlign: "center", fontSize: 23 },
  address: { fontSize: 16, letterSpacing: 0 },
});
