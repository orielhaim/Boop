import { ScreenHeader } from "@/components/navigation/screen-header";
import { Slider } from "@expo/ui/community/slider";
import { LinearGradient } from "expo-linear-gradient";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import {
  conversationMaterials,
  messagePresentation,
} from "@/components/messages/appearance";
import {
  SettingsDescription,
  SettingsGroup,
} from "@/components/settings/group";
import { SettingsMenuRow } from "@/components/settings/menu-row";
import { ThemePreference } from "@/components/settings/theme-preference";
import { Ink, Screen } from "@/components/ui/kit";
import {
  type ChatPresentation,
  chatPresentationControls,
} from "@/core/marmot/chat-preferences";
import { setPreference } from "@/db/queries";
import { namespaces } from "@/i18n";
import { useChatPresentation, useLocal } from "@/services/local-context";
import {
  favoritesDisplayKey,
  favoritesDisplays,
  useAppPreferences,
} from "@/stores/preferences";
import { space, useTheme } from "@/theme";

const controls = [
  { key: "textSize", label: "settings:messageTextSize" },
  { key: "rounding", label: "settings:messageRounding" },
] as const;

export default function AppearanceSettings() {
  const { t, i18n } = useTranslation(namespaces);
  const { colors, theme } = useTheme();
  const { chatPreferences, db } = useLocal();
  const favoritesDisplay = useAppPreferences((state) => state.favoritesDisplay);
  const presentation = useChatPresentation();
  const [failed, setFailed] = useState(false);
  const [favoritesFailed, setFavoritesFailed] = useState(false);
  const material = conversationMaterials[theme];
  const message = messagePresentation(presentation);
  const corners = { borderRadius: message.radii.bubble };
  const number = new Intl.NumberFormat(i18n.language);

  function change(key: keyof ChatPresentation, value: number) {
    try {
      chatPreferences.setPresentation(key, value);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  return (
    <Screen
      compact
      navigationHeader={<ScreenHeader title={t("settings:appearance")} />}
    >
      <ThemePreference />
      <SettingsGroup>
        <SettingsMenuRow
          title={t("settings:favoritesDisplay")}
          value={favoritesDisplay}
          options={favoritesDisplays.map((value) => ({
            value,
            label: t(
              value === "normal"
                ? "settings:favoritesNormal"
                : "settings:favoritesCool",
            ),
          }))}
          onChange={(value) => {
            try {
              setPreference(db, favoritesDisplayKey, value);
              useAppPreferences.setState({ favoritesDisplay: value });
              setFavoritesFailed(false);
            } catch {
              setFavoritesFailed(true);
            }
          }}
        />
      </SettingsGroup>
      {favoritesFailed && (
        <SettingsDescription>
          {t("settings:favoritesDisplaySaveError")}
        </SettingsDescription>
      )}
      <SettingsGroup title={t("common:chats")}>
        {controls.map(({ key, label }) => {
          const { min, max, step } = chatPresentationControls[key];
          return (
            <View key={key} style={styles.control}>
              <View style={styles.label}>
                <Ink kind="label" style={styles.title}>
                  {t(label)}
                </Ink>
                <Ink kind="caption" muted style={styles.value}>
                  {number.format(presentation[key])}
                </Ink>
              </View>
              <Slider
                accessibilityLabel={t(label)}
                minimumValue={min}
                maximumValue={max}
                step={step}
                value={presentation[key]}
                minimumTrackTintColor={colors.accent}
                maximumTrackTintColor={colors.accentSoft}
                thumbTintColor={colors.accent}
                onValueChange={(value) => change(key, value)}
              />
            </View>
          );
        })}
      </SettingsGroup>
      <LinearGradient
        colors={material.canvas}
        style={[styles.preview, { borderColor: material.rim }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <View
          style={[
            styles.bubble,
            styles.incoming,
            corners,
            { backgroundColor: material.incoming },
          ]}
        >
          <Ink style={message.text}>{t("settings:chatPreviewIncoming")}</Ink>
        </View>
        <LinearGradient
          colors={material.outgoing}
          style={[styles.bubble, styles.outgoing, corners]}
        >
          <Ink style={[message.text, { color: colors.outgoingInk }]}>
            {t("settings:chatPreviewOutgoing")}
          </Ink>
        </LinearGradient>
      </LinearGradient>
      {failed && (
        <SettingsDescription>
          {t("settings:chatAppearanceSaveError")}
        </SettingsDescription>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  preview: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
    padding: space.lg,
  },
  bubble: {
    maxWidth: "89%",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  incoming: { alignSelf: "flex-start" },
  outgoing: { alignSelf: "flex-end" },
  control: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  label: { flexDirection: "row", alignItems: "center", gap: space.md },
  title: { flex: 1 },
  value: { fontVariant: ["tabular-nums"] },
});
