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
import {
  callNavigationKeys,
  launchScreens,
  useAppPreferences,
} from "@/stores/preferences";

export default function CallsAndSounds() {
  const { t } = useTranslation(namespaces);
  const { db } = useLocal();
  const haptics = useAppPreferences((state) => state.haptics);
  const separateCallsTab = useAppPreferences((state) => state.separateCallsTab);
  const defaultScreen = useAppPreferences((state) => state.defaultScreen);
  const [error, setError] = useState("");

  function saveNavigation(
    choice:
      { separateCallsTab: boolean } | { defaultScreen: typeof defaultScreen },
  ) {
    try {
      if ("separateCallsTab" in choice) {
        setPreference(
          db,
          callNavigationKeys.separateTab,
          choice.separateCallsTab ? "on" : "off",
        );
      } else {
        setPreference(
          db,
          callNavigationKeys.defaultScreen,
          choice.defaultScreen,
        );
      }
      useAppPreferences.setState(choice);
      setError("");
    } catch {
      setError(t("settings:saveCallNavigationError"));
    }
  }
  return (
    <Screen>
      <SettingsGroup>
        <SettingsToggle
          title={t("settings:separateCallsTab")}
          icon="phone"
          value={separateCallsTab}
          onChange={(value) => saveNavigation({ separateCallsTab: value })}
        />
      </SettingsGroup>
      {separateCallsTab && (
        <SettingsGroup title={t("settings:defaultScreen")}>
          {launchScreens.map((screen) => (
            <SettingsRow
              key={screen}
              title={t(
                screen === "chats" ? "common:chats" : "navigation:calls",
              )}
              selected={defaultScreen === screen}
              onPress={() => saveNavigation({ defaultScreen: screen })}
            />
          ))}
        </SettingsGroup>
      )}
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
