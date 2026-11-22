import { router } from "expo-router";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { GlassBackButton, backButtonSize } from "@/components/ui/back-button";
import { Ink } from "@/components/ui/kit";
import { space } from "@/theme";

export type ScreenHeaderProps = {
  title: string;
  action?: ReactNode;
  onBack?: () => void;
};

export function ScreenHeader({ title, action, onBack }: ScreenHeaderProps) {
  return (
    <View style={styles.row}>
      <View style={styles.side}>
        <GlassBackButton
          elevation="none"
          onPress={
            onBack ??
            (() => {
              if (router.canGoBack()) router.back();
              else router.replace("/");
            })
          }
        />
      </View>
      <Ink
        kind="heading"
        accessibilityRole="header"
        numberOfLines={1}
        style={styles.title}
      >
        {title}
      </Ink>
      <View style={[styles.side, styles.trailing]}>{action}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  side: { flex: 1, minWidth: backButtonSize, alignItems: "flex-start" },
  trailing: { alignItems: "flex-end" },
  title: { flexShrink: 1, textAlign: "center" },
});
