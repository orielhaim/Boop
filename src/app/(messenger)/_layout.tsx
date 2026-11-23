import { BlankStack } from "react-native-screen-transitions/expo-router";
import { useNavigationMotion } from "@/components/navigation/motion";
import { ProfilePhotoControls } from "@/components/people/profile-photo-controls";
import { navigationScene } from "@/components/navigation/scene";
import { useChatsEnabled } from "@/services/local-context";

export const unstable_settings = { initialRouteName: "(tabs)" };

export default function MessengerLayout() {
  const chats = useChatsEnabled();
  const { push, detail, media, modal } = useNavigationMotion();

  return (
    <BlankStack screenOptions={push} screenLayout={navigationScene}>
      <BlankStack.Screen name="(tabs)" />
      <BlankStack.Screen name="settings" />
      <BlankStack.Screen name="person/[key]" options={detail} />
      <BlankStack.Screen
        name="profile-photo/[key]"
        options={{
          ...media,
          overlayShown: true,
          overlay: ProfilePhotoControls,
        }}
      />
      <BlankStack.Screen name="connect" options={modal} />
      <BlankStack.Screen name="add-contact" options={modal} />
      <BlankStack.Protected guard={chats}>
        <BlankStack.Screen
          name="chat/[key]"
          options={({ route }) => {
            const params = route.params;
            if (params && "view" in params && params.view === "details")
              return detail;
            if (params && "view" in params && params.view === "edit")
              return { ...push, gestureEnabled: false };
            if (params && "key" in params && params.key === "new-group")
              return { ...push, gestureEnabled: false };
            return push;
          }}
        />
        <BlankStack.Screen name="requests" />
      </BlankStack.Protected>
    </BlankStack>
  );
}
