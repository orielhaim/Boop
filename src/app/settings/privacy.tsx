import { router } from "expo-router";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import {
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
} from "@/components/settings/group";
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
  const { enabled } = useSyncExternalStore(lock.subscribe, lock.getState);
  return (
    <Screen>
      <SettingsGroup title={t("security:deviceAccess")}>
        <SettingsRow
          title={t("security:appLock")}
          value={enabled ? t("common:on") : t("common:off")}
          icon="lock"
          onPress={() => router.push("/settings/privacy/app-lock")}
        />
        <SettingsRow
          title={t("security:permissions")}
          icon="settings"
          onPress={() => router.push("/settings/privacy/permissions")}
        />
      </SettingsGroup>
      <SettingsGroup title={t("security:callPrivacy")}>
        <SettingsRow
          title={t("security:incomingVideo")}
          icon="camera"
          onPress={() => router.push("/settings/privacy/incoming-video")}
        />
      </SettingsGroup>
      <SettingsGroup title={t("security:whoCanCall")}>
        {(
          [
            ["everyone", "security:everyone"],
            ["contacts", "security:contactsOnly"],
            ["nobody", "security:nobody"],
          ] as const
        ).map(([value, label]) => (
          <SettingsRow
            key={value}
            title={t(label)}
            selected={selected.calls === value}
            onPress={() => privacy.set("calls", value)}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup>
        <SettingsToggle
          title={t("common:chats")}
          detail={t("security:chatsHelp")}
          value={chatsEnabled}
          onChange={(value) => {
            try {
              messaging.setChatsEnabled(value);
            } catch {
              Alert.alert(t("security:privacyWriteFailed"));
            }
          }}
        />
        <SettingsToggle
          title={t("security:messageRequests")}
          detail={t(
            strict ? "security:strictRequests" : "security:requestsHelp",
          )}
          disabled={!chatsEnabled || strict}
          value={selected.requests}
          onChange={(value) => privacy.set("requests", value)}
        />
      </SettingsGroup>
      <SettingsGroup title={t("security:whoCanMessage")}>
        {(
          [
            ["everyone", "security:everyone"],
            ["contacts", "security:contactsOnly"],
            ["initiated", "security:initiatedOnly"],
          ] as const
        ).map(([value, label]) => (
          <SettingsRow
            key={value}
            title={t(label)}
            selected={selected.messages === value}
            disabled={!chatsEnabled}
            onPress={() => privacy.set("messages", value)}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          title={t("security:blockedUsers")}
          icon="lock"
          onPress={() => router.push("/settings/privacy/blocked")}
        />
      </SettingsGroup>
    </Screen>
  );
}
