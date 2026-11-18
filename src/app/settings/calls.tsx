import { useState } from "react";
import { Platform } from "react-native";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
} from "@/components/settings/group";
import { Screen } from "@/components/ui/kit";
import { setPreference } from "@/db/queries";
import { useLocal } from "@/services/local";
import { useAppPreferences } from "@/stores/preferences";

export default function CallsAndSounds() {
  const { db } = useLocal();
  const haptics = useAppPreferences((state) => state.haptics);
  const [error, setError] = useState("");
  return (
    <Screen>
      <SettingsGroup>
        <SettingsRow
          title="Incoming ringtone"
          value={Platform.OS === "android" ? "Device default" : "Boop"}
          icon="speaker"
        />
        <SettingsToggle
          title="Haptic feedback"
          value={haptics}
          onChange={(value) => {
            try {
              setPreference(db, "haptics", value ? "on" : "off");
              useAppPreferences.setState({ haptics: value });
              setError("");
            } catch {
              setError("Could not save haptic feedback.");
            }
          }}
        />
      </SettingsGroup>
      {error && <SettingsDescription>{error}</SettingsDescription>}
    </Screen>
  );
}
