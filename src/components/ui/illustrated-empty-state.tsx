import type { ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Ink } from "./kit";

export function IllustratedEmptyState({
  artwork,
  title,
  detail,
  style,
  onLayout,
}: Pick<ViewProps, "style" | "onLayout"> & {
  artwork: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <View onLayout={onLayout} style={[styles.container, style]}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={styles.artwork}
      >
        {artwork}
      </View>
      <View style={styles.copy}>
        <Ink kind="heading" accessibilityRole="header" style={styles.text}>
          {title}
        </Ink>
        <Ink muted style={styles.text}>
          {detail}
        </Ink>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(({ space }) => ({
  container: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.lg,
    paddingHorizontal: space.sm,
    paddingVertical: space.xl,
  },
  artwork: {
    width: "100%",
    maxWidth: 240,
    height: 152,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { width: "100%", maxWidth: 320, gap: space.sm },
  text: { textAlign: "center" },
}));
