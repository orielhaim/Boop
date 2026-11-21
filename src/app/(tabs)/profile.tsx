import { router } from "expo-router";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { AvatarCropScreen, useAvatarPicker } from "@/components/avatars/picker";
import { GlassAvatar } from "@/components/glassyui/glass-avatar";
import { EditableAvatar } from "@/components/avatars/editable-avatar";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/group";
import {
  Action,
  Avatar,
  Header,
  Hero,
  Icon,
  Ink,
  Screen,
} from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { isolateText } from "@/i18n/format";
import { useChatsEnabled, useLocal } from "@/services/local-context";
import { space } from "@/theme";

export default function Profile() {
  const { t } = useTranslation(namespaces);
  const { identity, avatars, profileEditor } = useLocal();
  const picker = useAvatarPicker();
  useSyncExternalStore(profileEditor.subscribe, profileEditor.revision);
  const picture = useSyncExternalStore(
    (listener) => avatars.subscribe(identity.publicKey, listener),
    () => avatars.profile(identity.publicKey)?.picture,
  );
  const draft = profileEditor.draft();
  const preview = profileEditor.preview();
  const name = identity.npub.slice(0, 12);
  const canRemove =
    draft?.photo.kind !== "remove" && Boolean(picture || preview);
  const chatsEnabled = useChatsEnabled();
  if (picker.image) {
    return (
      <AvatarCropScreen
        source={picker.image}
        onCancel={picker.clear}
        onSave={(file) => {
          profileEditor.prepare(file.uri, draft?.name);
          picker.clear();
          router.push("/settings/identity/edit-profile");
        }}
      />
    );
  }

  return (
    <Screen tab>
      <Header title={t("navigation:profile")} />
      <Hero>
        <View style={styles.identity}>
          <EditableAvatar
            disabled={profileEditor.stage() !== "idle" || picker.busy}
            onPick={(source) => void picker.pick(source)}
            onRemove={
              canRemove
                ? () => {
                    try {
                      profileEditor.removePhoto(draft?.name);
                      router.push("/settings/identity/edit-profile");
                    } catch {
                      Alert.alert(t("security:privacyWriteFailed"));
                    }
                  }
                : undefined
            }
          >
            {preview || draft?.photo.kind === "remove" ? (
              <GlassAvatar name={name} src={preview} size="xl" />
            ) : (
              <Avatar publicKey={identity.publicKey} name={name} size="xl" />
            )}
          </EditableAvatar>
          {(preview || draft?.photo.kind === "remove") && (
            <Ink kind="caption" muted>
              {t("settings:photoDraft")}
            </Ink>
          )}
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
      {picker.error && (
        <SettingsDescription>{picker.error}</SettingsDescription>
      )}
      <SettingsGroup title={t("settings:preferences")}>
        <SettingsRow
          title={t("common:chats")}
          disabled={!chatsEnabled}
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
