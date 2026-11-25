import { ScreenHeader } from "@/components/navigation/screen-header";
import { router } from "expo-router";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Linking } from "react-native";
import { useDialog } from "@/components/ui/dialog";
import {
  ListGroup,
  ListRow,
  PreferenceToggle,
  SettingsDescription,
} from "@/components/ui/list-group";
import { SettingsMenuRow } from "@/components/settings/menu-row";
import { ProfilePhotoPolicyRow } from "@/components/settings/profile-photo-policy-row";
import { Screen } from "@/components/ui/kit";
import { usePrivacy } from "@/components/ui/privacy-actions";
import { linkPreviewPolicies } from "@/core/messaging/link-previews";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";

export default function Privacy() {
  const { t } = useTranslation(namespaces);
  const dialog = useDialog();
  const { lock, chatPreferences } = useLocal();
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
      void dialog.show({
        title: t("security:privacyWriteFailed"),
        tone: "error",
      });
    }
  }

  return (
    <Screen navigationHeader={<ScreenHeader title={t("settings:privacy")} />}>
      <ListGroup title={t("security:deviceAccess")}>
        <PreferenceToggle
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
        <ListRow
          title={t("security:permissions")}
          icon="settings"
          onPress={() => router.push("/settings/privacy/permissions")}
        />
      </ListGroup>
      <ListGroup>
        <ListRow
          title={t("security:incomingCalls")}
          icon="phone"
          onPress={() => router.push("/settings/privacy/incoming-calls")}
        />
      </ListGroup>
      <ListGroup>
        <PreferenceToggle
          title={t("common:chats")}
          detail={t("security:chatsHelp")}
          value={chatsEnabled}
          onChange={(value) => save(() => chatPreferences.setEnabled(value))}
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
        <PreferenceToggle
          title={t("security:messageRequests")}
          detail={t(
            strict ? "security:strictRequests" : "security:requestsHelp",
          )}
          disabled={!chatsEnabled || strict}
          value={selected.requests}
          onChange={(value) => save(() => privacy.set("requests", value))}
        />
      </ListGroup>
      <ListGroup>
        <SettingsMenuRow
          title={t("settings:linkPreviews")}
          value={selected.linkPreviews}
          options={linkPreviewPolicies.map((value) => ({
            value,
            label: t(`settings:linkPreview_${value}`),
          }))}
          onChange={(value) => save(() => privacy.set("linkPreviews", value))}
        />
      </ListGroup>
      <SettingsDescription>
        {t(`settings:linkPreviewHelp_${selected.linkPreviews}`)}{" "}
        {t("settings:linkPreviewPrivacy")}
      </SettingsDescription>
      <ListGroup>
        <ProfilePhotoPolicyRow
          title={t("settings:profilePhotos")}
          value={selected.profilePhotos}
          onTitlePress={() => router.push("/settings/privacy/profile-photos")}
          onChange={(value) => save(() => privacy.set("profilePhotos", value))}
        />
        <ListRow
          title={t("security:blockedUsers")}
          icon="lock"
          onPress={() => router.push("/settings/privacy/blocked")}
        />
        <PreferenceToggle
          title={t("security:telemetry")}
          detail={t("security:telemetryHelp")}
          value={false}
          onChange={(enabled) => {
            if (enabled) {
              void dialog.show({
                title: t("security:telemetry"),
                message: t("security:telemetryDeclined"),
                tone: "info",
              });
            }
          }}
        />
        <ListRow
          title={t("security:privacyPolicy")}
          icon="info"
          onPress={() => {
            void Linking.openURL("https://boop.orielhaim.com/privacy").catch(
              () =>
                void dialog.show({
                  title: t("security:privacyPolicyOpenFailed"),
                  tone: "error",
                }),
            );
          }}
        />
      </ListGroup>
    </Screen>
  );
}
