import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
} from "@/components/settings/group";
import { Screen } from "@/components/ui/kit";
import { setPreference } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { useAppPreferences } from "@/stores/preferences";

export default function CallsAndSounds() {
  const { t } = useTranslation(namespaces);
  const { db } = useLocal();
  const haptics = useAppPreferences((state) => state.haptics);
  const [error, setError] = useState("");
  return (
    <Screen>
      <SettingsGroup>
        <SettingsRow
          title={t("settings:incomingRingtone")}
          value={
            Platform.OS === "android" ? t("settings:deviceDefault") : "Boop"
          }
          icon="speaker"
        />
        <SettingsToggle
          title={t("settings:haptics")}
          value={haptics}
          onChange={(value) => {
            try {
              setPreference(db, "haptics", value ? "on" : "off");
              useAppPreferences.setState({ haptics: value });
              setError("");
            } catch {
              setError(t("settings:saveHapticsError"));
            }
          }}
        />
      </SettingsGroup>
      {error && <SettingsDescription>{error}</SettingsDescription>}
    </Screen>
  );
}
