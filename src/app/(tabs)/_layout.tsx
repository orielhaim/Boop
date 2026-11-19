import { NativeTabs } from "expo-router/native-tabs";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { unreadBadge } from "@/core/messaging/conversations";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";
import { useTheme } from "@/theme";

export default function TabLayout() {
  const { t } = useTranslation(namespaces);
  const { colors, reduceTransparency, theme } = useTheme();
  const { conversations } = useLocal();
  const badge = unreadBadge(
    useSyncExternalStore(
      conversations.subscribeUnread,
      conversations.getUnreadCount,
      conversations.getUnreadCount,
    ),
  );
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
          {t("navigation:calls")}
        </NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "phone", selected: "phone.fill" }}
          md="call"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="messages">
        <NativeTabs.Trigger.Label>
          {t("navigation:messages")}
        </NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: "bubble.left", selected: "bubble.left.fill" }}
          md="chat_bubble"
        />
        <NativeTabs.Trigger.Badge hidden={badge === undefined}>
          {badge}
        </NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="contacts">
        <NativeTabs.Trigger.Label>
          {t("navigation:contacts")}
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
