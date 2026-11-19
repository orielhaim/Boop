import {
  GlassTabBar,
  GlassTabButton,
  type GlassTabItem,
  renderFadingTabScreen,
  TabBarMinimizeProvider,
} from "expo-glass-tabs";
import { router } from "expo-router";
import { TabList, TabSlot, Tabs, TabTrigger } from "expo-router/ui";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { Icon, tapFeedback } from "@/components/ui/kit";
import { TabBarInsetProvider } from "@/components/ui/tab-bar-insets";
import { unreadBadge } from "@/core/messaging/conversations";
import { directionFor, namespaces, resolveLanguage } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local";
import { useTheme } from "@/theme";

export default function TabLayout() {
  const { t, i18n } = useTranslation(namespaces);
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const { colors, reduceMotion, reduceTransparency, theme } = useTheme();
  const { conversations } = useLocal();
  const chatsEnabled = useChatsEnabled();
  const badge = unreadBadge(
    useSyncExternalStore(
      conversations.subscribeUnread,
      conversations.getUnreadCount,
      conversations.getUnreadCount,
    ),
  );
  const calls: GlassTabItem = {
    name: "index",
    label: t("navigation:calls"),
    renderIcon: ({ tint, size }) => (
      <Icon name="phone" size={size} color={tint} />
    ),
  };
  const messages: GlassTabItem = {
    name: "messages",
    label: t("navigation:messages"),
    renderIcon: ({ tint, size }) => (
      <View style={styles.icon}>
        <Icon name="chat" size={size} color={tint} />
        {badge ? (
          <View style={[styles.badge, { backgroundColor: colors.danger }]}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
      </View>
    ),
  };
  const contacts: GlassTabItem = {
    name: "contacts",
    label: t("navigation:contacts"),
    renderIcon: ({ tint, size }) => (
      <Icon name="person" size={size} color={tint} />
    ),
  };
  const profile: GlassTabItem = {
    name: "profile",
    label: t("navigation:profile"),
    renderIcon: ({ tint, size }) => (
      <Icon name="settings" size={size} color={tint} />
    ),
  };
  const tabs = [
    { item: calls, href: "/" },
    { item: messages, href: "/messages" },
    { item: contacts, href: "/contacts" },
    { item: profile, href: "/profile" },
  ] as const;
  const visible = tabs.filter(
    ({ href }) => chatsEnabled || href !== "/messages",
  );
  const ordered = direction === "rtl" ? visible.reverse() : visible;

  return (
    <TabBarInsetProvider>
      <TabBarMinimizeProvider>
        <Tabs style={styles.navigator}>
          <TabSlot
            style={[styles.slot, { direction }]}
            renderFn={reduceMotion ? undefined : renderFadingTabScreen}
          />
          <TabList asChild>
            <GlassTabBar
              onIndexSelected={(index) => {
                const selected = ordered[index];
                if (!selected) return;
                tapFeedback();
                router.navigate(selected.href);
              }}
              haptics={!reduceMotion}
              theme={{
                activeTint: colors.accent,
                inactiveTint: colors.muted,
                highlight: colors.accentSoft,
                glassTint: reduceTransparency
                  ? colors.surface
                  : theme === "dark"
                    ? "rgba(20, 29, 51, 0.58)"
                    : "rgba(243, 246, 252, 0.66)",
                solidFallback: colors.surface,
              }}
            >
              {ordered.map(({ item, href }, index) => (
                <TabTrigger
                  key={item.name}
                  name={item.name}
                  href={href}
                  asChild
                >
                  <GlassTabButton
                    item={item}
                    index={index}
                    accessibilityLabel={
                      href === "/messages" && badge
                        ? `${item.label} (${badge})`
                        : item.label
                    }
                  />
                </TabTrigger>
              ))}
            </GlassTabBar>
          </TabList>
        </Tabs>
      </TabBarMinimizeProvider>
    </TabBarInsetProvider>
  );
}

const styles = StyleSheet.create({
  navigator: { flex: 1, direction: "ltr" },
  slot: { flex: 1 },
  icon: {
    width: 21,
    height: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    right: -9,
    top: -4,
    minWidth: 15,
    height: 15,
    paddingHorizontal: 3,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#FFFFFF", fontSize: 8, fontWeight: "700" },
});
