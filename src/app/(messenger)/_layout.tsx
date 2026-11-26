import { AudioFrame } from "@/components/audio/mini-player";
import { isActionHandled } from "expo-router";
import type { ComponentProps } from "react";
import { Platform } from "react-native";
import {
  BlankStack,
  type BlankStackNavigationOptions,
} from "react-native-screen-transitions/expo-router";
import { useNavigationMotion } from "@/components/navigation/motion";
import {
  ChatNavigationProvider,
  ChatSceneBackdrop,
} from "@/components/navigation/profile-reopen";
import { ProfilePhotoControls } from "@/components/people/profile-photo-controls";
import { Easing } from "react-native-reanimated";
import { useTheme } from "@/theme";
import {
  marmotChatScene,
  profileMorphParam,
  retainRecentConversation,
} from "@/core/marmot/conversation-route";
import { useChatsEnabled } from "@/services/local-context";
import { VideoFrame, videoNavigationScene } from "@/components/video/host";

const audioPlayerOptions: BlankStackNavigationOptions = {
  gestureEnabled: false,
  transitionSpec: {
    open: { duration: 0 },
    close: { duration: 180, easing: Easing.in(Easing.quad) },
  },
  screenStyleInterpolator: ({ current, layouts }) => {
    "worklet";
    if (current.route.name !== "audio-player" || !current.closing) return null;
    return {
      content: {
        transform: [
          { translateY: (1 - current.progress) * layouts.screen.height },
        ],
      },
    };
  },
};

export const unstable_settings = { anchor: "(tabs)" };

const keepRecentChat: NonNullable<
  ComponentProps<typeof BlankStack>["UNSTABLE_router"]
> = (router) => ({
  getStateForAction(state, action, options) {
    const warm = state.routes
      .slice(state.index + 1)
      .find((route) => route.name === "chat/[key]");
    // The prepared or last viewed conversation owns the single warm slot.
    if (
      action.type === "PRELOAD" &&
      action.payload &&
      "name" in action.payload &&
      action.payload.name === "chat/[key]" &&
      warm
    )
      return { state, affectedRouteKey: warm.key };
    const result = router.getStateForAction(state, action, options);
    if (!isActionHandled(result) || action.type !== "POP") return result;
    const next = retainRecentConversation(state, result.state);
    if (next === result.state) return result;
    return {
      ...result,
      state: next,
    };
  },
});

export default function MessengerLayout() {
  const chats = useChatsEnabled();
  const { reduceMotion } = useTheme();
  const { push, chat, detail, media, modal, profileMorph } =
    useNavigationMotion();

  return (
    <AudioFrame>
      <VideoFrame>
        <ChatNavigationProvider>
          <BlankStack
            UNSTABLE_router={Platform.OS === "web" ? undefined : keepRecentChat}
            screenOptions={push}
            screenLayout={videoNavigationScene}
            sceneContainer={ChatSceneBackdrop}
          >
            <BlankStack.Screen name="(tabs)" />
            <BlankStack.Screen name="settings" />
            <BlankStack.Screen name="downloads" />
            <BlankStack.Screen
              name="video-player"
              options={{ ...media, gestureEnabled: false }}
            />
            <BlankStack.Screen
              name="audio-player"
              options={
                reduceMotion
                  ? {
                      ...audioPlayerOptions,
                      transitionSpec: {
                        open: { duration: 0 },
                        close: { duration: 0 },
                      },
                    }
                  : audioPlayerOptions
              }
            />
            <BlankStack.Screen
              name="person/[key]"
              options={({ route }) =>
                profileMorphParam(route.params) ? profileMorph : detail
              }
            />
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
                dangerouslySingular={(_, params) =>
                  typeof params?.key === "string"
                    ? JSON.stringify([
                        params.key,
                        params.view,
                        params.messageTarget,
                      ])
                    : undefined
                }
                options={({ route }) => {
                  const params = route.params;
                  if (params && "view" in params && params.view === "details")
                    return profileMorphParam(params) ? profileMorph : detail;
                  if (params && "view" in params && params.view === "edit")
                    return { ...push, gestureEnabled: false };
                  if (params && "key" in params && params.key === "new-group")
                    return { ...push, gestureEnabled: false };
                  // Hidden BlankStack scenes disconnect effects, including the live chat window.
                  if (marmotChatScene(route)?.kind === "conversation")
                    return chat;
                  return push;
                }}
              />
              <BlankStack.Screen name="requests" />
              <BlankStack.Screen
                name="shared-media"
                options={{ ...push, inactiveBehavior: "keep" }}
              />
            </BlankStack.Protected>
          </BlankStack>
        </ChatNavigationProvider>
      </VideoFrame>
    </AudioFrame>
  );
}
