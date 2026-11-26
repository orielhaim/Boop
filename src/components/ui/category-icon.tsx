import { LinearGradient } from "expo-linear-gradient";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Icon, type IconName } from "@/components/ui/icon";

export const settingsCategories = [
  "appearance",
  "calls",
  "audio",
  "storage",
  "language",
  "identity",
  "devices",
  "privacy",
  "connections",
  "plugins",
  "about",
] as const;

export type SettingsCategory = (typeof settingsCategories)[number];

const categories = {
  appearance: {
    icon: "palette",
    colors: ["#E99580", "#B94D68"],
  },
  calls: {
    icon: "speaker",
    colors: ["#E7A265", "#C9554A"],
  },
  audio: {
    icon: "audio",
    colors: ["#8DBA96", "#39725F"],
  },
  storage: {
    icon: "storage",
    colors: ["#A69BD9", "#635A9D"],
  },
  language: {
    icon: "language",
    colors: ["#83B9CD", "#3E718F"],
  },
  identity: {
    icon: "key",
    colors: ["#8699D3", "#4F61A7"],
  },
  devices: {
    icon: "devices",
    colors: ["#749CE6", "#4059AC"],
  },
  privacy: {
    icon: "lock",
    colors: ["#6BB7A0", "#26765F"],
  },
  connections: {
    icon: "connection",
    colors: ["#79B5C6", "#3B758C"],
  },
  plugins: {
    icon: "plugins",
    colors: ["#BEA8E1", "#7955AC"],
  },
  about: {
    icon: "info",
    colors: ["#DAB36F", "#A66A3E"],
  },
} satisfies Record<
  SettingsCategory,
  { icon: IconName; colors: readonly [string, string] }
>;

export function CategoryIcon({ category }: { category: SettingsCategory }) {
  const item = categories[category];
  return (
    <View style={styles.frame}>
      <LinearGradient
        colors={item.colors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={["rgba(255, 255, 255, 0.28)", "rgba(255, 255, 255, 0)"]}
        locations={[0, 0.68]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Icon name={item.icon} size={17} color="#FFFFFF" weight="duotone" />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  frame: {
    width: 28,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.small,
    borderCurve: "continuous",
    overflow: "hidden",
    boxShadow: theme.glass.shadow,
  },
}));
