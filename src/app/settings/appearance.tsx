import { useState } from "react";
import { StyleSheet } from "react-native";
import {
  GlassSegmentedControl,
  GlassSegmentedControlItem,
} from "@/components/glassyui/glass-segmented-control";
import { SettingsDescription } from "@/components/settings/group";
import { Screen, Section } from "@/components/ui/kit";
import { setPreference } from "@/db/queries";
import { useLocal } from "@/services/local";
import { themes, useAppPreferences } from "@/stores/preferences";

export default function Appearance() {
  const { db } = useLocal();
  const selected = useAppPreferences((state) => state.theme);
  const [error, setError] = useState("");
  return (
    <Screen>
      <Section>Theme</Section>
      <GlassSegmentedControl
        accessibilityLabel="Theme"
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
            setError("Could not save the theme.");
          }
        }}
      >
        {themes.map((theme) => (
          <GlassSegmentedControlItem
            key={theme}
            value={theme}
            style={styles.option}
          >
            {{ system: "System", light: "Light", dark: "Dark" }[theme]}
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
