import { useIsFocused, useRoute } from "expo-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
} from "react";
import {
  BackHandler,
  type LayoutRectangle,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { GlassBackdrop, GlassProvider } from "react-native-liquid-engine";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type OverlayProps,
  useBlankStackStore,
  useScreenAnimation,
} from "react-native-screen-transitions";
import { createStore, type StoreApi, useStore } from "zustand";
import { ChatProfileBackButton } from "@/components/ui/back-button";
import { tapFeedback } from "@/components/ui/kit";
import { profileMorphParam } from "@/core/marmot/conversation-route";
import { useLocal } from "@/services/local-context";
import { space } from "@/theme";

type ChatHeader = {
  profile: string;
  onBack: () => void;
  topOffset: number;
  tint: string;
  profileLayout?: LayoutRectangle;
};

export function useDismissProfile(morph?: string) {
  const route = useRoute();
  const requestDismiss = useBlankStackStore((stack) => stack.requestDismiss);
  const top = useBlankStackStore(
    (stack) => stack.routes.at(-1)?.key === route.key,
  );
  const dismiss = useCallback(
    () => Boolean(morph && requestDismiss?.({ route, immediate: true })),
    [morph, requestDismiss, route],
  );
  useEffect(() => {
    if (!morph || !top) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      dismiss,
    );
    return () => subscription.remove();
  }, [dismiss, morph, top]);
  return dismiss;
}

const ChatNavigation = createContext<{
  headers: StoreApi<Map<string, ChatHeader>>;
  backdrop: string;
} | null>(null);

export function ChatNavigationProvider({ children }: { children: ReactNode }) {
  const [headers] = useState(() =>
    createStore<Map<string, ChatHeader>>(() => new Map()),
  );
  const backdrop = useId();
  const [navigation] = useState(() => ({ headers, backdrop }));
  return (
    <ChatNavigation.Provider value={navigation}>
      {children}
    </ChatNavigation.Provider>
  );
}

function useChatNavigationContext() {
  const navigation = useContext(ChatNavigation);
  if (!navigation) throw new Error("Missing ChatNavigationProvider");
  return navigation;
}

export function ChatSceneBackdrop({ children }: { children: ReactNode }) {
  const { backdrop } = useChatNavigationContext();
  return (
    <GlassBackdrop
      collapsable={false}
      sourceId={backdrop}
      style={StyleSheet.absoluteFill}
    >
      {children}
    </GlassBackdrop>
  );
}

function adjacentProfile<T extends { params?: object }>(
  routes: readonly T[],
  index: number,
  profile?: string,
) {
  const next = routes[index + 1];
  if (
    profile &&
    index === routes.length - 2 &&
    profileMorphParam(next?.params) === profile
  )
    return next;
}

export function useChatBackdropActive(routeKey: string) {
  const profile = useStore(
    useChatNavigationContext().headers,
    (headers) => headers.get(routeKey)?.profile,
  );
  return useBlankStackStore(({ routes }) => {
    const index = routes.findIndex(({ key }) => key === routeKey);
    return (
      index >= 0 &&
      (index === routes.length - 1 ||
        Boolean(adjacentProfile(routes, index, profile)))
    );
  });
}

export function useChatNavigation(header: ChatHeader | undefined) {
  const { headers } = useChatNavigationContext();
  const { key } = useRoute();
  useLayoutEffect(() => {
    if (!header) return;
    headers.setState((current) => new Map(current).set(key, header), true);
    return () => {
      headers.setState((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      }, true);
    };
  }, [header, headers, key]);
}

export function useSharedProfileBack(morph?: string) {
  const route = useRoute();
  const sourceKey = useBlankStackStore((stack) => {
    const index = stack.routes.findIndex(({ key }) => key === route.key);
    return stack.routes[index - 1]?.key;
  });
  return useStore(useChatNavigationContext().headers, (headers) =>
    Boolean(morph && sourceKey && headers.get(sourceKey)?.profile === morph),
  );
}

export function useProfilePresented(morph?: string) {
  const { key } = useRoute();
  const focused = useIsFocused();
  const activity = useBlankStackStore(
    (stack) => stack.scenesByKey[key]?.activity,
  );
  return (
    focused ||
    Boolean(morph && (activity === "closing" || activity === "inert"))
  );
}

export function ChatNavigationOverlay({ route, index, routes }: OverlayProps) {
  const { headers, backdrop } = useChatNavigationContext();
  const header = useStore(headers, (state) => state.get(route.key));
  const top = routes.at(-1);
  const profile = adjacentProfile(routes, index, header?.profile);
  const animation = useScreenAnimation(profile?.key ?? route.key);
  const canReopen = useAnimatedStyle(() => ({
    pointerEvents:
      profile && animation.get()?.current.closing ? "box-none" : "none",
  }));
  const dismiss = useBlankStackStore((stack) => stack.requestDismiss);
  const reopen = useBlankStackStore((stack) => stack.reopenClosingRoute);
  const { isCurrent, lock } = useLocal();
  const insets = useSafeAreaInsets();
  if (!header || (top?.key !== route.key && !profile)) return null;
  const { topOffset, tint, onBack, profileLayout } = header;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <GlassProvider sourceId={backdrop}>
        <ChatProfileBackButton
          offset={topOffset}
          lensTint={tint}
          onPress={() => {
            if (profile) dismiss?.({ route: profile, immediate: true });
            else onBack();
          }}
        />
      </GlassProvider>
      {profile && profileLayout && (
        <Animated.View style={[styles.profileTarget, canReopen]}>
          <Pressable
            accessible={false}
            importantForAccessibility="no"
            onPressIn={() => {
              const result =
                isCurrent() &&
                !lock.getState().locked &&
                reopen?.(
                  route.key,
                  (candidate) => candidate.key === profile.key,
                );
              if (result) tapFeedback();
            }}
            style={{
              position: "absolute",
              left: insets.left + space.sm + profileLayout.x,
              top: insets.top + topOffset + space.xs + profileLayout.y,
              width: profileLayout.width,
              height: profileLayout.height,
            }}
          />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  profileTarget: { ...StyleSheet.absoluteFill, direction: "ltr" },
});
