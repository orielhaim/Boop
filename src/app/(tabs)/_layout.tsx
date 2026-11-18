import { useLocales } from "expo-localization";
import { NativeTabs } from "expo-router/native-tabs";
import { Platform } from "react-native";
import { useTheme } from "@/theme";

export default function TabLayout() {
  const { colors, reduceTransparency, theme } = useTheme();
  const language = useLocales()[0]?.languageCode;
  const hebrew = language === "he" || language === "iw";
  return (
    <NativeTabs
      tintColor={colors.accent}
      backgroundColor={
        Platform.OS === "android" || reduceTransparency
          ? colors.surface
          : undefined
      }
      blurEffect={
        reduceTransparency
          ? "none"
          : theme === "dark"
            ? "systemMaterialDark"
            : "systemMaterialLight"
      }
      indicatorColor={colors.accentSoft}
      iconColor={{ default: colors.muted, selected: colors.accent }}
      labelStyle={{
        default: { color: colors.muted },
        selected: { color: colors.accent },
      }}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>
          {hebrew ? "שיחות" : "Calls"}
        </NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "phone", selected: "phone.fill" }}
          md="call"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="messages">
        <NativeTabs.Trigger.Label>
          {hebrew ? "הודעות" : "Messages"}
        </NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "bubble.left", selected: "bubble.left.fill" }}
          md="chat_bubble"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="contacts">
        <NativeTabs.Trigger.Label>
          {hebrew ? "אנשי קשר" : "Contacts"}
        </NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{
            default: "person.crop.circle",
            selected: "person.crop.circle.fill",
          }}
          md="contacts"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
