import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Ink, tapFeedback } from "@/components/ui/kit";
import { directionFor, resolveLanguage } from "@/i18n";
import { radius, space } from "@/theme";

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
  const { i18n } = useTranslation();
  const rtl = directionFor(resolveLanguage(i18n.resolvedLanguage)) === "rtl";
  return (
    <View
      accessibilityRole="tablist"
      style={[styles.tabs, { direction: rtl ? "rtl" : "ltr" }]}
    >
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
            style={[styles.tab, selected && styles.selected]}
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
  tab: {
    flex: 1,
    minWidth: 0,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.round,
    paddingHorizontal: space.md,
  },
  selected: { backgroundColor: colors.selected },
}));
