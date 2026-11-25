import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { Ink, tapFeedback } from "@/components/ui/kit";
import { directionFor, resolveLanguage } from "@/i18n";
import { motion, radius, space, useTheme } from "@/theme";

export type ProfileTab<Key extends string = string> = {
  key: Key;
  label: string;
};

export function ProfileTabs<Key extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly ProfileTab<Key>[];
  value: Key;
  onChange: (value: Key) => void;
}) {
  const { reduceMotion } = useTheme();
  const { i18n } = useTranslation();
  const rtl = directionFor(resolveLanguage(i18n.resolvedLanguage)) === "rtl";
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.key === value),
  );
  const tabWidth = Math.max(
    0,
    (width - 2 * space.lg - (tabs.length - 1) * space.xs) / tabs.length,
  );
  const x = useSharedValue(0);
  useEffect(() => {
    const target = index * (tabWidth + space.xs) * (rtl ? -1 : 1);
    x.set(reduceMotion ? target : withSpring(target, motion.travel));
  }, [index, reduceMotion, rtl, tabWidth, x]);
  const slide = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }],
  }));
  return (
    <View
      accessibilityRole="tablist"
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
      style={[styles.tabs, { direction: rtl ? "rtl" : "ltr" }]}
    >
      {tabWidth > 0 && (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          style={[styles.indicator, { width: tabWidth }, slide]}
        />
      )}
      {tabs.map((tab) => {
        const selected = tab.key === value;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={tab.label}
            onPress={() => {
              if (selected) return;
              tapFeedback();
              onChange(tab.key);
            }}
            style={styles.tab}
          >
            <Ink kind="label" muted={!selected} numberOfLines={1}>
              {tab.label}
            </Ink>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create(({ colors }) => ({
  tabs: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: colors.background,
  },
  indicator: {
    position: "absolute",
    start: space.lg,
    top: space.sm,
    bottom: space.sm,
    backgroundColor: colors.selected,
    borderRadius: radius.round,
  },
  tab: {
    flex: 1,
    minWidth: 0,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    paddingHorizontal: space.md,
  },
}));
