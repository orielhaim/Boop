import { Image } from "expo-image";
import { router } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { EditableAvatar } from "@/components/avatars/editable-avatar";
import { AvatarCropScreen, useAvatarPicker } from "@/components/avatars/picker";
import { GlassAvatar } from "@/components/glassyui/glass-avatar";
import { GlassInput } from "@/components/glassyui/glass-input";
import { GlassBackButton } from "@/components/ui/back-button";
import { CompactAction } from "@/components/ui/messenger-ui";
import { Action, Ink, Screen } from "@/components/ui/kit";
import { usePerson } from "@/components/people/use-person";
import { useAvatar } from "@/core/avatars/use-avatar";
import { profileDetails } from "@/core/avatars/protocol";
import { publicMediaUrl } from "@/core/media/url";
import { nip05Address } from "@/core/nostr/nip05";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { radius, space, useTheme } from "@/theme";

export default function EditProfile() {
  const { t } = useTranslation(namespaces);
  const { identity, profileEditor } = useLocal();
  const { name, photo, profile } = usePerson(identity.publicKey);
  const { colors } = useTheme();
  const banner = useAvatar(identity.publicKey, true, true);
  const { draft, stage, photoPreview, bannerPreview } = useSyncExternalStore(
    profileEditor.subscribe,
    profileEditor.getSnapshot,
  );
  const busy = stage !== "idle";
  const details = profileDetails(profile?.fields);
  const picker = useAvatarPicker();
  const bannerPicker = useAvatarPicker();
  const [edits, setEdits] = useState<
    Partial<Record<"name" | "about" | "website" | "nip05", string>>
  >({});
  const [notice, setNotice] = useState("");
  const current = {
    name: draft?.name ?? profile?.name ?? "",
    about: draft?.about ?? details.about ?? "",
    website: draft?.website ?? details.website ?? "",
    nip05: draft?.nip05 ?? details.nip05 ?? "",
  };
  const dirty = Object.entries(edits).some(
    ([key, value]) => current[key as keyof typeof current] !== value.trim(),
  );

  async function save() {
    const changes: typeof edits = {};
    for (const field of ["name", "about", "website", "nip05"] as const) {
      const value = edits[field]?.trim();
      if (value !== undefined && value !== current[field])
        changes[field] = value;
    }
    const nextName = changes.name ?? current.name;
    if (
      !nextName ||
      (changes.website && !publicMediaUrl(changes.website)) ||
      (changes.nip05 && !nip05Address(changes.nip05))
    ) {
      setNotice(t("messenger:invalidProfile"));
      return;
    }
    try {
      if (Object.keys(changes).length) profileEditor.editFields(changes);
      setEdits({});
      const status = await profileEditor.publish();
      setNotice(
        t(
          status === "published"
            ? "settings:photoPublished"
            : status === "mirror"
              ? "settings:photoMirrorFailed"
              : "messenger:pending",
        ),
      );
    } catch {
      setNotice(t("messenger:pending"));
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
    <Screen compact topInset>
      <View>
        <View style={[styles.banner, { backgroundColor: colors.accentSoft }]}>
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
              disabled={busy || picker.busy || bannerPicker.busy}
              onPress={() => void bannerPicker.pick("gallery")}
            />
            {draft?.banner?.kind !== "remove" &&
              (details.banner || bannerPreview) && (
                <CompactAction
                  icon="erase"
                  iconOnly
                  label={t("settings:photoRemove")}
                  disabled={busy}
                  onPress={() => profileEditor.removeImage("banner")}
                />
              )}
          </View>
        </View>
        <GlassBackButton
          style={styles.back}
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/profile");
          }}
        />
        <View style={[styles.avatar, { backgroundColor: colors.background }]}>
          <EditableAvatar
            disabled={busy || picker.busy || bannerPicker.busy}
            onPick={(source) => void picker.pick(source)}
            onRemove={
              draft?.photo.kind !== "remove" &&
              (profile?.picture || photoPreview)
                ? () => profileEditor.removeImage("photo")
                : undefined
            }
          >
            <GlassAvatar
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
            editable={!busy}
            onChangeText={(value) =>
              setEdits((previous) => ({ ...previous, [field]: value }))
            }
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
      {busy ? (
        <Ink accessibilityLiveRegion="polite">
          {t(
            stage === "uploading"
              ? "settings:photoUploading"
              : "settings:photoPublishing",
          )}
        </Ink>
      ) : (
        <View style={styles.saveRow}>
          <Action
            disabled={!dirty && !draft}
            variant="prominent"
            onPress={() => void save()}
          >
            {t("settings:photoPublish")}
          </Action>
          {(dirty || draft) && (
            <Action
              variant="soft"
              onPress={() => {
                profileEditor.discard();
                setEdits({});
                setNotice("");
              }}
            >
              {t("settings:photoDiscard")}
            </Action>
          )}
        </View>
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
  back: { position: "absolute", top: space.sm, start: space.sm },
  bannerTools: {
    position: "absolute",
    top: space.sm,
    end: space.sm,
    flexDirection: "row",
    gap: space.xs,
  },
  fields: { gap: space.md },
  bio: { minHeight: 65, textAlignVertical: "top" },
  saveRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
});
