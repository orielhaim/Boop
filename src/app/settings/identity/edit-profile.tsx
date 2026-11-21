import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { EditableAvatar } from "@/components/avatars/editable-avatar";
import { AvatarCropScreen, useAvatarPicker } from "@/components/avatars/picker";
import { GlassAvatar } from "@/components/glassyui/glass-avatar";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/group";
import { Action, Avatar, Screen, Search } from "@/components/ui/kit";
import { BlossomError } from "@/core/avatars/blossom";
import { useAvatar } from "@/core/avatars/use-avatar";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";
import { space } from "@/theme";

export default function EditProfile() {
  const { t } = useTranslation(namespaces);
  const { identity, avatars, profileEditor } = useLocal();
  useAvatar(identity.publicKey);
  const profile = useSyncExternalStore(
    (listener) => avatars.subscribe(identity.publicKey, listener),
    () => avatars.profile(identity.publicKey)?.name ?? "",
  );
  useSyncExternalStore(profileEditor.subscribe, profileEditor.revision);
  const draft = profileEditor.draft();
  const stage = profileEditor.stage();
  const busy = stage !== "idle";
  const picker = useAvatarPicker();
  const [input, setInput] = useState<string>();
  const [notice, setNotice] = useState("");
  const name = input ?? draft?.name ?? profile;
  const nameChange = name.trim() !== (draft?.name ?? profile);
  const displayName = name || identity.npub.slice(0, 12);
  const preview = profileEditor.preview();
  const canRemove =
    draft?.photo.kind !== "remove" &&
    Boolean(avatars.profile(identity.publicKey)?.picture || preview);

  async function publish() {
    setNotice("");
    try {
      if (nameChange) profileEditor.editName(name.trim());
      const status = await profileEditor.publish();
      if (status === "published" || status === "mirror") {
        setInput(undefined);
        setNotice(
          t(
            status === "published"
              ? "settings:photoPublished"
              : "settings:photoMirrorFailed",
          ),
        );
      } else if (status === "cancelled")
        setNotice(t("settings:photoUpload_cancelled"));
      else setNotice(t("settings:photoRelayFailed"));
    } catch (error) {
      setNotice(
        error instanceof BlossomError
          ? t(`settings:photoUpload_${error.code}`)
          : t("settings:photoRelayFailed"),
      );
    }
  }

  if (picker.image) {
    return (
      <AvatarCropScreen
        source={picker.image}
        onCancel={picker.clear}
        onSave={(file) => {
          profileEditor.prepare(
            file.uri,
            nameChange ? name.trim() : draft?.name,
          );
          picker.clear();
        }}
      />
    );
  }
  return (
    <Screen>
      <View style={styles.profile}>
        <EditableAvatar
          disabled={busy || picker.busy}
          onPick={(source) => void picker.pick(source)}
          onRemove={
            canRemove
              ? () => {
                  try {
                    profileEditor.removePhoto(
                      nameChange ? name.trim() : draft?.name,
                    );
                    setNotice("");
                  } catch {
                    setNotice(t("security:privacyWriteFailed"));
                  }
                }
              : undefined
          }
        >
          {preview || draft?.photo.kind === "remove" ? (
            <GlassAvatar name={displayName} src={preview} size="xl" />
          ) : (
            <Avatar
              name={displayName}
              publicKey={identity.publicKey}
              size="xl"
            />
          )}
        </EditableAvatar>
      </View>
      <Search
        placeholder={t("settings:photoDisplayName")}
        accessibilityLabel={t("settings:photoDisplayName")}
        value={name}
        editable={!busy}
        maxLength={128}
        onChangeText={setInput}
      />
      <SettingsGroup>
        <SettingsRow
          title={t("settings:publicAddress")}
          detail={identity.npub}
        />
      </SettingsGroup>
      <SettingsDescription>{t("settings:photoPublic")}</SettingsDescription>
      {draft && (
        <SettingsDescription>{t("settings:photoDraft")}</SettingsDescription>
      )}
      {notice && <SettingsDescription>{notice}</SettingsDescription>}
      {picker.error && (
        <SettingsDescription>{picker.error}</SettingsDescription>
      )}
      {busy ? (
        <>
          <SettingsDescription>
            {t(
              stage === "uploading"
                ? "settings:photoUploading"
                : "settings:photoPublishing",
            )}
          </SettingsDescription>
          {stage === "uploading" && (
            <Action variant="soft" onPress={profileEditor.cancel}>
              {t("common:cancel")}
            </Action>
          )}
        </>
      ) : (
        <>
          <Action
            disabled={!draft && !nameChange}
            onPress={() => void publish()}
          >
            {t("settings:photoPublish")}
          </Action>
          {draft && (
            <Action
              variant="soft"
              onPress={() => {
                profileEditor.discard();
                setInput(undefined);
                setNotice("");
              }}
            >
              {t("settings:photoDiscard")}
            </Action>
          )}
        </>
      )}
    </Screen>
  );
}
const styles = StyleSheet.create({
  profile: { alignItems: "center", paddingVertical: space.sm },
});
