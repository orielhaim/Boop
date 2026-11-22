import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { glassStackBack } from "@/components/ui/back-button";
import { namespaces } from "@/i18n";
import { useChatsEnabled } from "@/services/local-context";
import { useTheme } from "@/theme";

export default function SettingsLayout() {
  const { t } = useTranslation(namespaces);
  const chatsEnabled = useChatsEnabled();
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={({ navigation }) => ({
        ...glassStackBack(navigation.goBack),
        contentStyle: { backgroundColor: colors.background },
        headerStyle: { backgroundColor: "transparent" },
        headerShadowVisible: false,
        headerTitleAlign: "center",
        headerTitleStyle: { color: colors.text },
      })}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen
        name="identity"
        options={{ title: t("settings:identity") }}
      />

      <Stack.Screen name="edit-profile" options={{ headerShown: false }} />
      <Stack.Screen
        name="privacy/profile-photos"
        options={{ title: t("settings:profilePhotos") }}
      />
      <Stack.Screen
        name="privacy/link-previews"
        options={{ title: t("settings:linkPreviews") }}
      />
      <Stack.Screen
        name="connections/media-storage"
        options={{ title: t("settings:mediaStorage") }}
      />
      <Stack.Screen name="storage" options={{ title: t("storage:title") }} />
      <Stack.Screen name="chats" options={{ title: t("common:chats") }} />
      <Stack.Screen
        name="language"
        options={{ title: t("settings:language") }}
      />
      <Stack.Screen name="calls" options={{ title: t("settings:calls") }} />
      <Stack.Protected guard={chatsEnabled}>
        <Stack.Screen
          name="identity/backup"
          options={{ title: t("messages:marmot.backups") }}
        />
        <Stack.Screen
          name="identity/devices"
          options={{ title: t("messages:marmot.devices") }}
        />
        <Stack.Screen
          name="language/translation/index"
          options={{ title: t("translation:title") }}
        />
        <Stack.Screen
          name="language/translation/target"
          options={{ title: t("translation:target") }}
        />
        <Stack.Screen
          name="language/translation/excluded"
          options={{ title: t("translation:excluded") }}
        />
        <Stack.Screen
          name="language/translation/models"
          options={{ title: t("translation:manageModels") }}
        />
      </Stack.Protected>
      <Stack.Screen name="privacy" options={{ title: t("settings:privacy") }} />
      <Stack.Screen
        name="privacy/blocked"
        options={{ title: t("security:blockedUsers") }}
      />
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
