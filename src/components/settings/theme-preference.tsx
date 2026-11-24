import { useFocusEffect } from "expo-router";
import { type ComponentRef, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  GlassSegmentedControl,
  GlassSegmentedControlItem,
} from "@/components/glassyui/glass-segmented-control";
import { SettingsDescription } from "@/components/ui/list-group";
import { Section } from "@/components/ui/kit";
import { useThemeRevealControl } from "@/components/ui/theme-switch";
import { setPreference } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { themes, useAppPreferences } from "@/stores/preferences";
import { space } from "@/theme";

export function ThemePreference() {
  const { t } = useTranslation(namespaces);
  const { db } = useLocal();
  const selected = useAppPreferences((state) => state.theme);
  const [error, setError] = useState("");
  const control = useRef<ComponentRef<typeof View>>(null);
  const { keepControlLive, displayedChoice } = useThemeRevealControl();
  useFocusEffect(
    useCallback(() => {
      if (control.current) return keepControlLive(control.current);
    }, [keepControlLive]),
  );
  return (
    <View style={styles.group}>
      <Section>{t("settings:theme")}</Section>
      <GlassSegmentedControl
        ref={control}
        accessibilityLabel={t("settings:theme")}
        value={selected}
        displayedValue={displayedChoice}
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
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: space.sm },
  theme: { alignSelf: "stretch" },
  option: { minHeight: 44 },
});
