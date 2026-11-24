import { useIsFocused } from "expo-router";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { LoadingStatus } from "@/components/ui/loading-status";
import {
  Shimmer,
  useShimmerProgress,
} from "@/components/ui/molecules/Shimmer/Shimmer";
import { directionFor, resolveLanguage } from "@/i18n";
import { radius, space, useTheme } from "@/theme";

export function LoadingSkeleton({
  label,
  layout = "settings",
}: {
  label: string;
  layout?: "chats" | "person" | "settings" | "storage";
}) {
  const { i18n } = useTranslation();
  const focused = useIsFocused();
  const { colors, reduceMotion, theme } = useTheme();
  const active = focused && !reduceMotion;
  const progress = useShimmerProgress(active);
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const shape = {
    background: colors.line,
    highlight: theme === "dark" ? "#495773" : colors.background,
    progress: active ? progress : undefined,
    rtl: direction === "rtl",
  };

  return (
    <View style={[styles.container, { direction }]}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
      >
        {layout === "storage" && (
          <View style={styles.chart}>
            <Shimmer {...shape} style={styles.chartPlaceholder} />
          </View>
        )}
        {(layout === "person" ? [0] : [0, 1, 2]).map((index) => (
          <View
            key={index}
            style={[
              styles.row,
              (layout === "chats" || layout === "person") && styles.personRow,
            ]}
          >
            {(layout === "chats" || layout === "person") && (
              <Shimmer {...shape} style={styles.avatar} />
            )}
            <View style={styles.lines}>
              <Shimmer
                {...shape}
                style={index === 1 ? styles.title : styles.line}
              />
              {layout === "chats" && (
                <Shimmer {...shape} style={styles.preview} />
              )}
            </View>
            {layout === "storage" && (
              <Shimmer {...shape} style={styles.value} />
            )}
          </View>
        ))}
      </View>
      <LoadingStatus label={label} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: space.sm, padding: space.sm },
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.sm,
  },
  personRow: { minHeight: 66 },
  avatar: { width: 46, height: 46, borderRadius: radius.round },
  lines: { flex: 1, gap: space.sm },
  line: { width: "52%", height: 13, borderRadius: radius.round },
  title: { width: "63%", height: 13, borderRadius: radius.round },
  preview: { width: "76%", height: 9, borderRadius: radius.round },
  chart: { alignItems: "center", paddingVertical: space.md },
  chartPlaceholder: { width: 128, height: 128, borderRadius: radius.round },
  value: { width: 50, height: 12, borderRadius: radius.round },
});
