import { router } from "expo-router";
import { useSyncExternalStore } from "react";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { Screen } from "@/components/ui/kit";
import { useLocal } from "@/services/local";

export default function Privacy() {
  const { lock } = useLocal();
  const { enabled } = useSyncExternalStore(lock.subscribe, lock.getState);
  return (
    <Screen>
      <SettingsGroup title="Device access">
        <SettingsRow
          title="App Lock"
          value={enabled ? "On" : "Off"}
          icon="lock"
          onPress={() => router.push("/settings/privacy/app-lock")}
        />
        <SettingsRow
          title="Device permissions"
          icon="settings"
          onPress={() => router.push("/settings/privacy/permissions")}
        />
      </SettingsGroup>
      <SettingsGroup title="Call privacy">
        <SettingsRow
          title="Incoming video"
          icon="camera"
          onPress={() => router.push("/settings/privacy/incoming-video")}
        />
      </SettingsGroup>
    </Screen>
  );
}
