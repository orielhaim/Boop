import { useIsFocused } from "expo-router";
import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function navigationScene({ children }: { children: ReactNode }) {
  return <NavigationScene>{children}</NavigationScene>;
}

function NavigationScene({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  return (
    <View
      style={styles.content}
      pointerEvents={focused ? "box-none" : "none"}
      accessibilityElementsHidden={!focused}
      importantForAccessibility={focused ? "auto" : "no-hide-descendants"}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({ content: { flex: 1 } });
