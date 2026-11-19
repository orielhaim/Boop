import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { namespaces } from "@/i18n";

export const unstable_settings = { anchor: "index" };

export default function SettingsLayout() {
  const { t } = useTranslation(namespaces);
  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: "minimal" }}>
      <Stack.Screen
        name="index"
        options={{ title: t("navigation:settings") }}
      />
      <Stack.Screen
        name="identity"
        options={{ title: t("settings:identity") }}
      />

      <Stack.Screen
        name="appearance"
        options={{ title: t("settings:appearance") }}
      />
      <Stack.Screen
        name="language"
        options={{ title: t("settings:language") }}
      />
      <Stack.Screen name="calls" options={{ title: t("settings:calls") }} />
      <Stack.Screen name="chats" options={{ title: t("common:chats") }} />
      <Stack.Screen
        name="chats/translation"
        options={{ title: t("translation:title") }}
      />
      <Stack.Screen
        name="chats/target"
        options={{ title: t("translation:target") }}
      />
      <Stack.Screen
        name="chats/models"
        options={{ title: t("translation:manageModels") }}
      />
      <Stack.Screen name="privacy" options={{ title: t("settings:privacy") }} />
      <Stack.Screen
        name="privacy/app-lock"
        options={{ title: t("security:appLock") }}
      />
      <Stack.Screen
        name="privacy/permissions"
        options={{ title: t("security:permissions") }}
      />
      <Stack.Screen
        name="privacy/incoming-video"
        options={{ title: t("security:incomingVideo") }}
      />
      <Stack.Screen
        name="connections"
        options={{ title: t("settings:connections") }}
      />
      <Stack.Screen name="about" options={{ title: t("settings:about") }} />
    </Stack>
  );
}
