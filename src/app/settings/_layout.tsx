import { Stack } from "expo-router";

export const unstable_settings = { anchor: "index" };

export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerBackButtonDisplayMode: "minimal" }}>
      <Stack.Screen name="index" options={{ title: "Settings" }} />
      <Stack.Screen name="identity" options={{ title: "Identity & keys" }} />

      <Stack.Screen name="appearance" options={{ title: "Appearance" }} />
      <Stack.Screen name="calls" options={{ title: "Calls & sounds" }} />
      <Stack.Screen name="privacy" options={{ title: "Privacy & security" }} />
      <Stack.Screen name="privacy/app-lock" options={{ title: "App Lock" }} />
      <Stack.Screen
        name="privacy/permissions"
        options={{ title: "Device permissions" }}
      />
      <Stack.Screen
        name="privacy/incoming-video"
        options={{ title: "Incoming video" }}
      />
      <Stack.Screen name="connections" options={{ title: "Connections" }} />
      <Stack.Screen name="about" options={{ title: "About" }} />
    </Stack>
  );
}
