import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native";
import {
  GlassSegmentedControl,
  GlassSegmentedControlItem,
} from "@/components/glassyui/glass-segmented-control";
import { SettingsDescription } from "@/components/settings/group";
import { Screen, Section } from "@/components/ui/kit";
import { setPreference } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { themes, useAppPreferences } from "@/stores/preferences";

export default function Appearance() {
  const { t } = useTranslation(namespaces);
  const { db } = useLocal();
  const selected = useAppPreferences((state) => state.theme);
  const [error, setError] = useState("");
  return (
    <Screen>
      <Section>{t("settings:theme")}</Section>
      <GlassSegmentedControl
        accessibilityLabel={t("settings:theme")}
        value={selected}
        style={styles.theme}
        onValueChange={(value) => {
          const theme = themes.find((item) => item === value);
          if (!theme) return;
          try {
            setPreference(db, "theme", theme);
            useAppPreferences.setState({ theme });
            setError("");
          } catch {
            setError(t("settings:saveThemeError"));
          }
        }}
      >
        {themes.map((theme) => (
          <GlassSegmentedControlItem
            key={theme}
            value={theme}
            style={styles.option}
          >
            {
              {
                system: t("settings:system"),
                light: t("settings:light"),
                dark: t("settings:dark"),
              }[theme]
            }
          </GlassSegmentedControlItem>
        ))}
      </GlassSegmentedControl>
      {error && <SettingsDescription>{error}</SettingsDescription>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  theme: { alignSelf: "stretch" },
  option: { minHeight: 44 },
});
