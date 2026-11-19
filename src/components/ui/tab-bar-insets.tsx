import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const TabBarInsetContext = createContext(0);

/** Keeps tab screen content clear of the floating glass dock. */
export function TabBarInsetProvider({ children }: { children: ReactNode }) {
  const { bottom } = useSafeAreaInsets();
  const clearance = useMemo(
    () => Math.max(bottom - 16, 12) + 58 + 12,
    [bottom],
  );

  return (
    <TabBarInsetContext.Provider value={clearance}>
      {children}
    </TabBarInsetContext.Provider>
  );
}

export function useTabBarClearance() {
  return useContext(TabBarInsetContext);
}
