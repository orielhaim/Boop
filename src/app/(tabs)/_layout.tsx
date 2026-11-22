import {
  GlassTabBar,
  GlassTabButton,
  type GlassTabItem,
  renderFadingTabScreen,
  TabBarMinimizeProvider,
} from "expo-glass-tabs";
import { router, usePathname } from "expo-router";
import { TabList, TabSlot, Tabs, TabTrigger } from "expo-router/ui";
import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Icon, tapFeedback } from "@/components/ui/kit";
import {
  TabBarInsetProvider,
  useTabBarBottomOffset,
} from "@/components/ui/tab-bar-insets";
import { useAccountMarmotWindow } from "@/components/messages/marmot-window";
import { marmot } from "@/core/marmot/native";
import { directionFor, namespaces, resolveLanguage } from "@/i18n";
import { useChatsEnabled } from "@/services/local-context";
import { useAppPreferences } from "@/stores/preferences";
import { useTheme } from "@/theme";

export default function TabLayout() {
  return (
    <SafeAreaProvider>
      <TabBarMinimizeProvider>
        <DockNavigator />
      </TabBarMinimizeProvider>
    </SafeAreaProvider>
  );
}

function DockNavigator() {
  const bottomOffset = useTabBarBottomOffset();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const { t, i18n } = useTranslation(namespaces);
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const { colors, reduceMotion, reduceTransparency, theme } = useTheme();
  const chatsEnabled = useChatsEnabled();
  const separateCallsTab = useAppPreferences((state) => state.separateCallsTab);
  const defaultScreen = useAppPreferences((state) => state.defaultScreen);
  const pathname = usePathname();
  const openCallsOnLaunch = useRef(
    separateCallsTab && defaultScreen === "calls" && pathname === "/",
  );
  useLayoutEffect(() => {
    if (!openCallsOnLaunch.current) return;
    openCallsOnLaunch.current = false;
    if (pathname === "/") router.replace("/calls");
  }, [pathname]);
  const { snapshot } = useAccountMarmotWindow(
    marmot.openAttention,
    chatsEnabled,
  );
  const unread = snapshot?.count ?? 0;
  const badge = unread > 99 ? "99+" : unread || null;
  const messages: GlassTabItem = {
    name: "index",
    label: t("common:chats"),
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
  const people: GlassTabItem = {
    name: "people",
    label: t("messenger:people"),
    renderIcon: ({ tint, size }) => (
      <Icon name="people" size={size} color={tint} />
    ),
  };
  const calls: GlassTabItem = {
    name: "calls",
    label: t("navigation:calls"),
    renderIcon: ({ tint, size }) => (
      <Icon name="phone" size={size} color={tint} />
    ),
  };
  const profile: GlassTabItem = {
    name: "profile",
    label: t("navigation:profile"),
    renderIcon: ({ tint, size }) => (
      <Icon name="person" size={size} color={tint} />
    ),
  };
  const chatsTab = { item: messages, href: "/" } as const;
  const callsTab = { item: calls, href: "/calls" } as const;
  const conversationTabs = !separateCallsTab
    ? [chatsTab]
    : defaultScreen === "calls"
      ? [callsTab, chatsTab]
      : [chatsTab, callsTab];
  const tabs = [
    ...conversationTabs,
    { item: people, href: "/people" },
    { item: profile, href: "/profile" },
  ] as const;
  const ordered = direction === "rtl" ? [...tabs].reverse() : tabs;

  return (
    <TabBarInsetProvider bottomOffset={keyboardVisible ? null : bottomOffset}>
      <Tabs style={styles.navigator}>
        <TabSlot
          style={[styles.slot, { direction }]}
          renderFn={reduceMotion ? undefined : renderFadingTabScreen}
        />
        <TabList asChild>
          <GlassTabBar
            bottomOffset={bottomOffset}
            hidden={keyboardVisible}
            edgeFadeColor={colors.background}
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
              <TabTrigger key={item.name} name={item.name} href={href} asChild>
                <GlassTabButton
                  item={item}
                  index={index}
                  accessibilityLabel={
                    href === "/" && badge
                      ? `${item.label} (${badge})`
                      : item.label
                  }
                />
              </TabTrigger>
            ))}
          </GlassTabBar>
        </TabList>
      </Tabs>
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
