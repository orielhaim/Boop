import {
  DockTabButton,
  ExpandableDock,
  type DockItem,
} from "@/components/navigation/expandable-dock";
import {
  animateDockSelection,
  DockMinimizeProvider,
  useDockMotion,
} from "@/components/navigation/dock-motion";
import { router, useIsFocused, usePathname } from "expo-router";
import { TabList, TabTrigger, useTabsWithChildren } from "expo-router/ui";
import { DirectionalTabs } from "@/components/navigation/directional-tabs";
import { resolveTabPressTarget } from "@/components/navigation/tab-travel";
import { TabFabVisibility } from "@/components/navigation/tab-fab-visibility";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { scheduleOnUI } from "react-native-worklets";
import { Icon, tapFeedback } from "@/components/ui/kit";
import { CountBadge } from "@/components/kinetik/count-badge";
import { MorphFab } from "@/components/ui/molecules/morph-fab";
import { ScreenInsets } from "@/components/ui/screen-insets";
import { useIdentitySheet } from "@/components/people/identity-sheet";
import { PersonAvatar } from "@/components/people/person-avatar";
import { usePerson } from "@/components/people/use-person";
import {
  TabBarInsetProvider,
  useTabBarBottomOffset,
} from "@/components/ui/tab-bar-insets";
import { useAccountMarmotWindow } from "@/components/messages/marmot-window";
import { marmot } from "@/core/marmot/native";
import { directionFor, namespaces, resolveLanguage } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";
import { useAppPreferences } from "@/stores/preferences";
import { useTheme } from "@/theme";
import { themes } from "@/theme/tokens";
import {
  GlassBackdropProvider,
  GlassBackdropTarget,
} from "@/components/glassyui/lib/glass-backdrop";

export default function TabLayout() {
  return (
    <DockMinimizeProvider>
      <DockNavigator />
    </DockMinimizeProvider>
  );
}

function DockNavigator() {
  const dockMotion = useDockMotion();
  const { pageIntent } = dockMotion;
  const focused = useIsFocused();
  const bottomOffset = useTabBarBottomOffset();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const { t, i18n } = useTranslation(namespaces);
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const { colors, reduceMotion, theme } = useTheme();
  const { identity, initialProfile } = useLocal();
  const {
    name: accountName,
    photo,
    profile: accountProfile,
  } = usePerson(identity.publicKey, false);
  const dockMaterial = themes[theme].glass.dock;
  const chatsEnabled = useChatsEnabled();
  const showIdentitySheet = useIdentitySheet();
  const [chatsVisible, setChatsVisible] = useState(true);
  const [peopleSection, setPeopleSection] = useState<"contacts" | "calls">(
    "contacts",
  );
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
  const messages: DockItem = {
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
      </View>
    ),
    renderIconOverlay: () => (
      <View style={{ direction }}>
        <CountBadge
          count={unread}
          size="compact"
          ringColor={dockMaterial.opaque}
        >
          <View style={styles.icon} />
        </CountBadge>
      </View>
    ),
  };
  const people: DockItem = {
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
  const calls: DockItem = {
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
  const profile: DockItem = {
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
  const visibleTabs = ordered.filter(({ item }) => item.name !== "profile");

  const dock = (
    <TabList asChild>
      <ExpandableDock
        items={visibleTabs.map(({ item }) => item)}
        bottomOffset={bottomOffset}
        hidden={keyboardVisible || !focused}
        closeLabel={t("common:close")}
        direction={direction}
        accountName={accountName}
        accountAvatar={
          <PersonAvatar
            publicKey={identity.publicKey}
            name={accountName}
            photo={photo}
            hasName={Boolean(accountProfile?.name || initialProfile.name)}
            size="dock"
          />
        }
        accountLabel={t("navigation:accountActions")}
        profileActionLabel={t("navigation:profile")}
        qrLabel={t("navigation:accountQr")}
        onAccountPress={() => router.navigate("/profile")}
        onQrPress={() => showIdentitySheet("qr")}
        onTabSelect={selectTab}
      >
        {ordered.map(({ item, href }) => {
          const visibleIndex = visibleTabs.findIndex(
            ({ item: visibleItem }) => visibleItem.name === item.name,
          );
          return (
            <TabTrigger key={item.name} name={item.name} href={href} asChild>
              <DockTabButton
                item={item}
                index={visibleIndex >= 0 ? visibleIndex : 0}
                visible={visibleIndex >= 0}
                onTabSelect={selectTab}
                accessibilityLabel={
                  href === "/" && unread > 0
                    ? `${item.label}, ${t("messages:attentionCount", { count: unread })}`
                    : item.label
                }
              />
            </TabTrigger>
          );
        })}
      </ExpandableDock>
    </TabList>
  );
  const { state, navigation, NavigationContent } = useTabsWithChildren({
    children: dock,
  });
  function selectTab(name: string) {
    const destination = visibleTabs.find(({ item }) => item.name === name);
    if (!destination) return;
    const current = navigation.getState();
    const target = resolveTabPressTarget(current, name, destination.href);
    if (!target) return;
    const event = navigation.emit({
      type: "tabPress",
      target: target.eventTarget,
      canPreventDefault: true,
    });
    const currentRoute = current.routes[current.index];
    if (event.defaultPrevented) {
      pageIntent.set(undefined);
      const index = visibleTabs.findIndex(
        ({ item }) => item.name === currentRoute?.name,
      );
      if (index >= 0)
        scheduleOnUI(animateDockSelection, dockMotion, index, reduceMotion);
      return;
    }
    if (target.selected) return;
    tapFeedback();
    if (!reduceMotion) pageIntent.set(name);
    // The route already belongs to this navigator. Dispatch directly so a
    // local tab switch does not wait for the URL routing queue to drain.
    navigation.dispatchSync({
      type: "JUMP_TO",
      payload: { name },
      target: current.key,
    });
  }
  const active = state.routes[state.index]?.name;
  const callsActive =
    (active === "calls" && separateCallsTab) ||
    (active === "people" && !separateCallsTab && peopleSection === "calls");
  const showFab =
    !keyboardVisible &&
    ((active === "index" && chatsEnabled && chatsVisible) ||
      active === "people" ||
      callsActive);
  const actionColor = colors.outgoingInk;
  const scanAction = {
    label: t("contacts:scanQr"),
    icon: <Icon name="qr" color={actionColor} />,
    onSelect: () =>
      router.push(
        callsActive
          ? { pathname: "/scan", params: { action: "call" } }
          : "/scan",
      ),
  };
  const fabProps =
    active === "people" || callsActive
      ? {
          mode: "menu" as const,
          label: callsActive
            ? t("calls:newCall")
            : t("contacts:contactActions"),
          actions: callsActive
            ? [
                scanAction,
                {
                  label: t("calls:enterId"),
                  icon: <Icon name="keyboard" color={actionColor} />,
                  onSelect: () => router.push("/dial-address"),
                },
              ]
            : [
                {
                  label: t("navigation:addContact"),
                  icon: <Icon name="addPerson" color={actionColor} />,
                  onSelect: () => router.push("/add-contact"),
                },
                scanAction,
              ],
        }
      : {
          mode: "action" as const,
          label: t("chatKit:labels.chatListNewChat"),
          onPress: () => showIdentitySheet("newConversation"),
        };

  return (
    <GlassBackdropProvider active={focused}>
      <TabBarInsetProvider bottomOffset={keyboardVisible ? null : bottomOffset}>
        <View style={styles.navigator}>
          <NavigationContent>
            <TabFabVisibility.Provider
              value={{ setChatsVisible, peopleSection, setPeopleSection }}
            >
              <GlassBackdropTarget>
                <DirectionalTabs
                  active={active}
                  order={ordered.map(({ item }) => item.name)}
                  warmRoutes={visibleTabs.map(({ item }) => item.name)}
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
                    {...fabProps}
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
    </GlassBackdropProvider>
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
});
