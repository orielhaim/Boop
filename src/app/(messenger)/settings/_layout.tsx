import { BlankStack } from "react-native-screen-transitions/expo-router";
import { useNavigationMotion } from "@/components/navigation/motion";
import { navigationScene } from "@/components/navigation/scene";
import { useChatsEnabled } from "@/services/local-context";

export const unstable_settings = { anchor: "index" };

export default function SettingsLayout() {
  const chatsEnabled = useChatsEnabled();
  const { push } = useNavigationMotion();

  return (
    <BlankStack screenOptions={push} screenLayout={navigationScene}>
      <BlankStack.Screen name="index" />
      <BlankStack.Screen
        name="identity-keys"
        options={{ gestureEnabled: false }}
      />
      <BlankStack.Protected guard={chatsEnabled}>
        <BlankStack.Screen name="identity/backup" />
        <BlankStack.Screen name="identity/devices" />
        <BlankStack.Screen name="language/translation/index" />
        <BlankStack.Screen name="language/translation/target" />
        <BlankStack.Screen name="language/translation/excluded" />
        <BlankStack.Screen name="language/translation/models" />
        <BlankStack.Screen name="language/voice-transcription/index" />
        <BlankStack.Screen name="language/voice-transcription/models" />
      </BlankStack.Protected>
    </BlankStack>
  );
}
