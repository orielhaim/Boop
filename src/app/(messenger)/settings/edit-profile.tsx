import { Image } from "expo-image";
import { router } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { EditableAvatar } from "@/components/avatars/editable-avatar";
import { AvatarCropScreen, useAvatarPicker } from "@/components/avatars/picker";
import { GlassAvatar } from "@/components/glassyui/glass-avatar";
import { GlassInput } from "@/components/glassyui/glass-input";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { CompactAction } from "@/components/ui/messenger-ui";
import { Action, Ink, Screen } from "@/components/ui/kit";
import { LoadingStatus } from "@/components/ui/loading-status";
import { SaveButton } from "@/components/ui/save-button";
import { usePerson } from "@/components/people/use-person";
import { useAvatar } from "@/core/avatars/use-avatar";
import { publicMediaUrl } from "@/core/media/url";
import { nip05Address } from "@/core/nostr/nip05";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { radius, space, useTheme } from "@/theme";

export default function EditProfile() {
  const { t } = useTranslation(namespaces);
  const { identity, initialProfile, profileEditor } = useLocal();
  const { name, photo, profile } = usePerson(identity.publicKey);
  const { colors } = useTheme();
  const banner = useAvatar(identity.publicKey, true, true);
  const { draft, stage, error, photoPreview, bannerPreview } =
    useSyncExternalStore(profileEditor.subscribe, profileEditor.getSnapshot);
  const pendingImages =
    (draft?.photo && draft.photo.kind !== "unchanged") ||
    (draft?.banner && draft.banner.kind !== "unchanged");
  const picker = useAvatarPicker();
  const bannerPicker = useAvatarPicker();
  const [edits, setEdits] = useState<
    Partial<Record<"name" | "about" | "website" | "nip05", string>>
  >({});
  const [notice, setNotice] = useState("");
  const current = {
    name: draft?.name ?? (profile ? profile.name : initialProfile.name) ?? "",
    about:
      draft?.about ?? (profile ? profile?.about : initialProfile.about) ?? "",
    website: draft?.website ?? profile?.website ?? "",
    nip05: draft?.nip05 ?? profile?.nip05 ?? "",
  };
  const changes: typeof edits = {};
  for (const field of ["name", "about", "website", "nip05"] as const) {
    const value = edits[field]?.trim();
    if (value !== undefined && value !== current[field]) changes[field] = value;
  }
  const dirty = Object.keys(changes).length > 0;

  function save() {
    if (
      !(changes.name ?? current.name) ||
      (changes.website && !publicMediaUrl(changes.website)) ||
      (changes.nip05 && !nip05Address(changes.nip05))
    ) {
      setNotice(t("messenger:invalidProfile"));
      return false;
    }
    try {
      profileEditor.editFields(changes);
      setEdits({});
      setNotice("");
      return true;
    } catch {
      return false;
    }
  }

  function removeImage(field: "photo" | "banner") {
    try {
      profileEditor.removeImage(field);
      setNotice("");
    } catch {
      setNotice(t("settings:photoProcessFailed"));
    }
  }

  const selected = picker.image ?? bannerPicker.image;
  if (selected) {
    const wide = Boolean(bannerPicker.image);
    const clear = wide ? bannerPicker.clear : picker.clear;
    return (
      <AvatarCropScreen
        source={selected}
        wide={wide}
        topInset
        onCancel={clear}
        onSave={(file) => {
          profileEditor.prepare(file.uri, wide ? "banner" : "photo");
          setNotice("");
          clear();
        }}
      />
    );
  }
  const fields = [
    { field: "name", title: t("messenger:publicName"), limit: 128 },
    { field: "about", title: t("messenger:about"), limit: 1000 },
    { field: "website", title: t("messenger:website"), limit: 2048 },
    { field: "nip05", title: t("messenger:nip05"), limit: 254 },
  ] as const;
  return (
    <Screen
      compact
      navigationHeader={
        <ScreenHeader
          title={t("settings:editProfile")}
          onBack={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/settings");
          }}
          action={
            <SaveButton
              size="sm"
              visible={dirty}
              label={t("common:save")}
              onSave={save}
            />
          }
        />
      }
    >
      <View>
        <View style={[styles.banner, { backgroundColor: colors.selected }]}>
          {draft?.banner?.kind !== "remove" && (bannerPreview || banner) && (
            <Image
              source={bannerPreview || banner}
              contentFit="cover"
              style={StyleSheet.absoluteFill}
            />
          )}
          <View style={styles.bannerTools}>
            <CompactAction
              icon="edit"
              label={t("messenger:banner")}
              disabled={picker.busy || bannerPicker.busy}
              onPress={() => void bannerPicker.pick("gallery")}
            />
            {draft?.banner?.kind !== "remove" &&
              (profile?.banner || bannerPreview) && (
                <CompactAction
                  icon="trash"
                  iconOnly
                  label={t("settings:photoRemove")}
                  onPress={() => removeImage("banner")}
                />
              )}
          </View>
        </View>
        <View style={[styles.avatar, { backgroundColor: colors.background }]}>
          <EditableAvatar
            disabled={picker.busy || bannerPicker.busy}
            onPick={(source) => void picker.pick(source)}
            onRemove={
              draft?.photo.kind !== "remove" &&
              (profile?.picture || photoPreview)
                ? () => removeImage("photo")
                : undefined
            }
          >
            <GlassAvatar
              identityKey={identity.publicKey}
              name={edits.name || draft?.name || name}
              size="xl"
              src={
                draft?.photo.kind === "remove"
                  ? undefined
                  : (photoPreview ?? photo)
              }
            />
          </EditableAvatar>
        </View>
      </View>
      <View style={styles.fields}>
        {fields.map(({ field, title, limit }) => (
          <GlassInput
            key={field}
            compact
            style={field === "about" ? styles.bio : undefined}
            label={title}
            value={edits[field] ?? current[field]}
            maxLength={limit}
            multiline={field === "about"}
            autoCapitalize={
              field === "website" || field === "nip05" ? "none" : undefined
            }
            autoCorrect={field !== "website" && field !== "nip05"}
            onChangeText={(value) => {
              setNotice("");
              setEdits((previous) => ({ ...previous, [field]: value }));
            }}
          />
        ))}
      </View>
      <Ink kind="caption" muted>
        {t("settings:photoPublic")}
      </Ink>
      {notice && <Ink accessibilityLiveRegion="polite">{notice}</Ink>}
      {(picker.error || bannerPicker.error) && (
        <Ink accessibilityRole="alert">
          {picker.error || bannerPicker.error}
        </Ink>
      )}
      {draft && error && stage === "idle" && (
        <Action variant="soft" onPress={profileEditor.retry}>
          {t("messages:editRetry")}
        </Action>
      )}
      {pendingImages && stage !== "idle" && (
        <LoadingStatus
          label={t(
            stage === "uploading"
              ? "settings:photoUploading"
              : "settings:photoPublishing",
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignSelf: "center",
    padding: 4,
    marginTop: -38,
    borderRadius: radius.round,
  },
  banner: { height: 120, borderRadius: 16, overflow: "hidden" },
  bannerTools: {
    position: "absolute",
    top: space.sm,
    end: space.sm,
    flexDirection: "row",
    gap: space.xs,
  },
  fields: { gap: space.md },
  bio: { minHeight: 65, textAlignVertical: "top" },
});
