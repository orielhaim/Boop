import {
  EXPANDED_HEIGHT,
  MINIMIZED_HEIGHT,
  useTabBarMinimized,
} from "expo-glass-tabs";
import { createContext, type ReactNode, useContext } from "react";
import { Platform } from "react-native";
import {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const DOCK_GAP = 12;
const TabBarInsetContext = createContext<number | null>(null);

// The provider measures only the part of the tab viewport inside system bars.
export function useTabBarBottomOffset() {
  const { bottom } = useSafeAreaInsets();
  return Platform.OS === "android"
    ? bottom + DOCK_GAP
    : Math.max(bottom - 16, DOCK_GAP);
}

export function TabBarInsetProvider({
  bottomOffset,
  children,
}: {
  bottomOffset: number | null;
  children: ReactNode;
}) {
  return (
    <TabBarInsetContext.Provider value={bottomOffset}>
      {children}
    </TabBarInsetContext.Provider>
  );
}

export function useTabBarClearance(safeBottom: number, padding: number) {
  const bottomOffset = useContext(TabBarInsetContext);
  const progress = useTabBarMinimized();

  return useAnimatedStyle(() => {
    if (bottomOffset === null) {
      return { paddingBottom: padding + safeBottom };
    }

    const height = interpolate(
      progress.value,
      [0, 1],
      [EXPANDED_HEIGHT, MINIMIZED_HEIGHT],
      Extrapolation.CLAMP,
    );
    return {
      paddingBottom:
        padding + Math.max(safeBottom, bottomOffset + height + DOCK_GAP),
    };
  });
}
