import { router } from "expo-router";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Linking } from "react-native";
import {
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
} from "@/components/settings/group";
import { SettingsMenuRow } from "@/components/settings/menu-row";
import { ProfilePhotoPolicyRow } from "@/components/settings/profile-photo-policy-row";
import { Screen } from "@/components/ui/kit";
import { usePrivacy } from "@/components/ui/privacy-actions";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local";

export default function Privacy() {
  const { t } = useTranslation(namespaces);
  const { lock, messaging } = useLocal();
  const chatsEnabled = useChatsEnabled();
  const privacy = usePrivacy();
  const selected = privacy.preferences();
  const strict = selected.messages === "initiated";
  const {
    enabled,
    authenticating,
    error: lockError,
  } = useSyncExternalStore(lock.subscribe, lock.getState);
  const everyone = {
    value: "everyone",
    label: t("security:everyone"),
  } as const;
  const contacts = {
    value: "contacts",
    label: t("security:contactsOnly"),
  } as const;
  function save(write: () => void) {
    try {
      write();
    } catch {
      Alert.alert(t("security:privacyWriteFailed"));
    }
  }

  return (
    <Screen>
      <SettingsGroup title={t("security:deviceAccess")}>
        <SettingsToggle
          title={t("security:appLock")}
          detail={
            authenticating
              ? t("security:authenticating")
              : lockError
                ? t(`security:${lockError}`)
                : undefined
          }
          value={enabled}
          disabled={authenticating}
          icon="lock"
          onTitlePress={() => router.push("/settings/privacy/app-lock")}
          onChange={(value) => void lock.change(value ? "enable" : "disable")}
        />
        <SettingsRow
          title={t("security:permissions")}
          icon="settings"
          onPress={() => router.push("/settings/privacy/permissions")}
        />
      </SettingsGroup>
      <SettingsGroup title={t("security:callPrivacy")}>
        <SettingsMenuRow
          title={t("security:whoCanCall")}
          value={selected.calls}
          options={[
            everyone,
            contacts,
            { value: "nobody", label: t("security:nobody") },
          ]}
          onChange={(value) => save(() => privacy.set("calls", value))}
        />
        <SettingsRow
          title={t("security:incomingVideo")}
          icon="camera"
          onPress={() => router.push("/settings/privacy/incoming-video")}
        />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsToggle
          title={t("common:chats")}
          detail={t("security:chatsHelp")}
          value={chatsEnabled}
          onChange={(value) => save(() => messaging.setChatsEnabled(value))}
        />
        <SettingsMenuRow
          title={t("security:whoCanMessage")}
          value={selected.messages}
          options={[
            everyone,
            contacts,
            { value: "initiated", label: t("security:initiatedOnly") },
          ]}
          disabled={!chatsEnabled}
          onChange={(value) => save(() => privacy.set("messages", value))}
        />
        <SettingsToggle
          title={t("security:messageRequests")}
          detail={t(
            strict ? "security:strictRequests" : "security:requestsHelp",
          )}
          disabled={!chatsEnabled || strict}
          value={selected.requests}
          onChange={(value) => save(() => privacy.set("requests", value))}
        />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          title={t("settings:linkPreviews")}
          detail={t(`settings:linkPreview_${selected.linkPreviews}`)}
          onPress={() => router.push("/settings/privacy/link-previews")}
        />
        <ProfilePhotoPolicyRow
          title={t("settings:profilePhotos")}
          value={selected.profilePhotos}
          onTitlePress={() => router.push("/settings/privacy/profile-photos")}
          onChange={(value) => save(() => privacy.set("profilePhotos", value))}
        />
        <SettingsRow
          title={t("security:blockedUsers")}
          icon="lock"
          onPress={() => router.push("/settings/privacy/blocked")}
        />
        <SettingsRow
          title={t("security:privacyPolicy")}
          icon="info"
          onPress={() => {
            void Linking.openURL("https://boop.orielhaim.com/privacy").catch(
              () => Alert.alert(t("security:privacyPolicyOpenFailed")),
            );
          }}
        />
      </SettingsGroup>
    </Screen>
  );
}
