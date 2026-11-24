import {
  GlassTabBar,
  GlassTabButton,
  type GlassTabItem,
  TabBarMinimizeProvider,
} from "expo-glass-tabs";
import { router, useIsFocused, usePathname } from "expo-router";
import { TabList, TabTrigger, useTabsWithChildren } from "expo-router/ui";
import { DirectionalTabs } from "@/components/navigation/directional-tabs";
import { TabFabVisibility } from "@/components/navigation/tab-fab-visibility";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { Icon, tapFeedback } from "@/components/ui/kit";
import { MorphFab } from "@/components/ui/molecules/morph-fab";
import { ScreenInsets } from "@/components/ui/screen-insets";
import { useIdentitySheet } from "@/components/people/identity-sheet";
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
import {
  GlassBackdropProvider,
  GlassBackdropTarget,
  useGlassBackdropTarget,
} from "@/components/glassyui/lib/glass-backdrop";

export default function TabLayout() {
  return (
    <TabBarMinimizeProvider>
      <GlassBackdropProvider>
        <DockNavigator />
      </GlassBackdropProvider>
    </TabBarMinimizeProvider>
  );
}

function DockNavigator() {
  const blurTarget = useGlassBackdropTarget();
  const focused = useIsFocused();
  const bottomOffset = useTabBarBottomOffset();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const { t, i18n } = useTranslation(namespaces);
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const { colors, reduceMotion, reduceTransparency, theme } = useTheme();
  const chatsEnabled = useChatsEnabled();
  const showIdentitySheet = useIdentitySheet();
  const [chatsVisible, setChatsVisible] = useState(true);
  const [peopleVisible, setPeopleVisible] = useState(true);
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
        <Icon
          name="chat"
          size={size}
          color={tint}
          weight={tint === colors.accent ? "fill" : "regular"}
        />
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
      <Icon
        name="people"
        size={size}
        color={tint}
        weight={tint === colors.accent ? "fill" : "regular"}
      />
    ),
  };
  const calls: GlassTabItem = {
    name: "calls",
    label: t("navigation:calls"),
    renderIcon: ({ tint, size }) => (
      <Icon
        name="phone"
        size={size}
        color={tint}
        weight={tint === colors.accent ? "fill" : "regular"}
      />
    ),
  };
  const profile: GlassTabItem = {
    name: "profile",
    label: t("navigation:profile"),
    renderIcon: ({ tint, size }) => (
      <Icon
        name="person"
        size={size}
        color={tint}
        weight={tint === colors.accent ? "fill" : "regular"}
      />
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

  const dock = (
    <TabList asChild>
      <GlassTabBar
        blurTarget={
          focused && !reduceTransparency ? (blurTarget ?? undefined) : undefined
        }
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
          highlight: colors.selected,
          glassTint: reduceTransparency
            ? colors.raised
            : theme === "dark"
              ? "rgba(20, 29, 51, 0.58)"
              : "rgba(243, 246, 252, 0.66)",
          solidFallback: colors.raised,
        }}
      >
        {ordered.map(({ item, href }, index) => (
          <TabTrigger key={item.name} name={item.name} href={href} asChild>
            <GlassTabButton
              item={item}
              index={index}
              accessibilityLabel={
                href === "/" && badge ? `${item.label} (${badge})` : item.label
              }
            />
          </TabTrigger>
        ))}
      </GlassTabBar>
    </TabList>
  );
  const { state, NavigationContent } = useTabsWithChildren({ children: dock });
  const active = state.routes[state.index]?.name;
  const showFab =
    !keyboardVisible &&
    ((active === "index" && chatsEnabled && chatsVisible) ||
      (active === "people" && peopleVisible));

  return (
    <TabBarInsetProvider bottomOffset={keyboardVisible ? null : bottomOffset}>
      <View style={styles.navigator}>
        <NavigationContent>
          <TabFabVisibility.Provider
            value={{ setChatsVisible, setPeopleVisible }}
          >
            <GlassBackdropTarget>
              <DirectionalTabs
                active={active}
                order={ordered.map(({ item }) => item.name)}
                style={{ direction }}
                reduceMotion={reduceMotion}
              />
            </GlassBackdropTarget>
          </TabFabVisibility.Provider>
          {showFab && (
            <ScreenInsets
              edges={["left", "right"]}
              pointerEvents="box-none"
              style={StyleSheet.absoluteFill}
            >
              <View pointerEvents="box-none" style={styles.fabContent}>
                <MorphFab
                  {...(active === "people"
                    ? {
                        mode: "menu",
                        label: t("contacts:contactActions"),
                        actions: [
                          {
                            label: t("navigation:addContact"),
                            icon: (
                              <Icon
                                name="addPerson"
                                color={colors.outgoingInk}
                              />
                            ),
                            onSelect: () => router.push("/add-contact"),
                          },
                          {
                            label: t("contacts:scanQr"),
                            icon: <Icon name="qr" color={colors.outgoingInk} />,
                            onSelect: () => router.push("/scan"),
                          },
                        ],
                      }
                    : {
                        mode: "action",
                        label: t("chatKit:labels.chatListNewChat"),
                        onPress: () => showIdentitySheet("newConversation"),
                      })}
                  closeLabel={t("common:close")}
                  rtl={direction === "rtl"}
                  trigger={
                    <Icon name="add" size={29} color={colors.outgoingInk} />
                  }
                />
              </View>
            </ScreenInsets>
          )}
          {dock}
        </NavigationContent>
      </View>
    </TabBarInsetProvider>
  );
}

const styles = StyleSheet.create({
  navigator: { flex: 1, direction: "ltr" },
  fabContent: { flex: 1 },
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
