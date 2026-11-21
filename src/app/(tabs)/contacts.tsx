import { useAvatarVisibility } from "@/core/avatars/use-avatar";
import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Swipeable, {
  type SwipeableMethods,
  SwipeDirection,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import {
  GlassSegmentedControl,
  GlassSegmentedControlItem,
} from "@/components/glassyui/glass-segmented-control";
import {
  Action,
  Avatar,
  Empty,
  Header,
  Icon,
  IconButton,
  Ink,
  Row,
  Screen,
  Search,
} from "@/components/ui/kit";
import { useBlockAction } from "@/components/ui/privacy-actions";
import { byNameOrKey, useContacts } from "@/db/contacts";
import { updateContactPreferences } from "@/db/queries";
import { directionFor, namespaces, resolveLanguage } from "@/i18n";
import { isolateText } from "@/i18n/format";
import { useChatsEnabled, useLocal } from "@/services/local";
import { radius, space, useTheme } from "@/theme";

export default function Contacts() {
  const { t } = useTranslation(namespaces);
  const [query, search] = useState("");
  const [filter, setFilter] = useState("all");
  const [expandedKey, setExpandedKey] = useState<string>();
  const contacts = useContacts().filter(
    (contact) =>
      (filter !== "favorites" || contact.favorite) &&
      byNameOrKey(query, contact.publicKey, contact.name),
  );
  const visibleAvatars = useAvatarVisibility<(typeof contacts)[number]>(
    (contact) => contact.publicKey,
  );
  const add = () => router.push("/contact/new");

  return (
    <Screen tab scroll={false}>
      <View style={styles.top}>
        <Header title={t("navigation:contacts")}>
          <IconButton
            icon="add"
            label={t("navigation:addContact")}
            tone="accent"
            onPress={add}
          />
        </Header>
        <Search
          value={query}
          onChangeText={search}
          accessibilityLabel={t("contacts:search")}
          placeholder={t("contacts:search")}
        />
        <GlassSegmentedControl
          value={filter}
          onValueChange={setFilter}
          accessibilityLabel={t("contacts:filter")}
        >
          <GlassSegmentedControlItem value="all">
            {t("contacts:all")}
          </GlassSegmentedControlItem>
          <GlassSegmentedControlItem value="favorites">
            {t("contacts:favorites")}
          </GlassSegmentedControlItem>
        </GlassSegmentedControl>
      </View>
      <FlashList
        {...visibleAvatars}
        data={contacts}
        extraData={expandedKey}
        keyExtractor={(item) => item.publicKey}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListEmptyComponent={
          <Empty
            icon={filter === "favorites" ? "star" : "person"}
            title={
              query
                ? t("contacts:noResults")
                : filter === "favorites"
                  ? t("contacts:noFavorites")
                  : t("contacts:empty")
            }
            detail={
              query
                ? t("contacts:searchHint")
                : filter === "favorites"
                  ? t("contacts:favoriteHint")
                  : t("contacts:emptyHint")
            }
          >
            {!query && filter === "all" && (
              <Action onPress={add}>{t("navigation:addContact")}</Action>
            )}
          </Empty>
        }
        renderItem={({ item }) => (
          <ContactRow
            contact={item}
            expanded={expandedKey === item.publicKey}
            onToggle={() =>
              setExpandedKey((open) =>
                open === item.publicKey ? undefined : item.publicKey,
              )
            }
          />
        )}
      />
    </Screen>
  );
}

const actions = [
  { label: "contacts:info", icon: "info", route: "/contact/[key]" },
  { label: "calls:call", icon: "phone", route: "/call/[key]" },
  { label: "contacts:message", icon: "chat", route: "/chat/[key]" },
] as const;

function ContactRow({
  contact,
  expanded,
  onToggle,
}: {
  contact: ReturnType<typeof useContacts>[number];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, i18n } = useTranslation(namespaces);
  const rtl = directionFor(resolveLanguage(i18n.resolvedLanguage)) === "rtl";
  const { colors } = useTheme();
  const swipeable = useRef<SwipeableMethods>(null);
  const { name, publicKey, favorite } = contact;
  const block = useBlockAction(publicKey);
  const chatsEnabled = useChatsEnabled();
  const { db } = useLocal();
  const renderQuickCall = () => (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.quickCall, { backgroundColor: colors.outgoing }]}
    >
      <Icon name="phone" color={colors.outgoingInk} />
      <Ink kind="caption" style={{ color: colors.outgoingInk }}>
        {t("calls:call")}
      </Ink>
    </View>
  );
  return (
    <View
      style={[
        styles.item,
        { borderColor: colors.line, backgroundColor: colors.surface },
      ]}
    >
      <Swipeable
        ref={swipeable}
        {...(rtl
          ? {
              leftThreshold: 64,
              overshootLeft: false,
              dragOffsetFromLeft: 14,
              renderLeftActions: renderQuickCall,
            }
          : {
              rightThreshold: 64,
              overshootRight: false,
              dragOffsetFromRight: -14,
              renderRightActions: renderQuickCall,
            })}
        onSwipeableOpen={(direction) => {
          swipeable.current?.reset();
          if (block.blocked) return;
          if (direction === (rtl ? SwipeDirection.RIGHT : SwipeDirection.LEFT))
            router.push({
              pathname: "/call/[key]",
              params: { key: publicKey },
            });
        }}
      >
        <View style={{ backgroundColor: colors.surface }}>
          <Row
            leading={
              <Avatar name={name} publicKey={publicKey} autoLoad={false} />
            }
            title={name}
            trailing={
              <View style={styles.indicators}>
                {favorite ? <Icon name="favorite" size={16} /> : null}
                <Icon name={expanded ? "collapse" : "expand"} size={18} />
              </View>
            }
            expanded={expanded}
            onPress={onToggle}
            onLongPress={onToggle}
          />
        </View>
      </Swipeable>
      {expanded ? (
        <View style={[styles.actions, { borderTopColor: colors.line }]}>
          {actions
            .filter(({ route }) => chatsEnabled || route !== "/chat/[key]")
            .map(({ label, icon, route }) => (
              <View key={label} style={styles.action}>
                <IconButton
                  icon={icon}
                  disabled={route === "/call/[key]" && block.blocked}
                  label={`${t(label)} Ã‚Â· ${isolateText(name)}`}
                  onPress={() =>
                    router.push({ pathname: route, params: { key: publicKey } })
                  }
                />
                <Ink kind="caption" muted>
                  {t(label)}
                </Ink>
              </View>
            ))}
          <View style={styles.action}>
            <IconButton
              icon={favorite ? "favorite" : "star"}
              label={t(
                favorite ? "contacts:removeFavorite" : "contacts:addFavorite",
              )}
              onPress={() =>
                updateContactPreferences(db, publicKey, { favorite: !favorite })
              }
            />
            <IconButton
              icon="lock"
              label={block.label}
              onPress={block.onPress}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    paddingBottom: space.lg,
  },
  list: { paddingHorizontal: space.xl, paddingBottom: space.xxl },
  item: {
    marginBottom: space.sm,
    borderRadius: radius.input,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  indicators: { flexDirection: "row", alignItems: "center", gap: space.sm },
  quickCall: {
    width: 86,
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
  },
  actions: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: space.md,
  },
  action: { flex: 1, alignItems: "center", gap: space.xs },
});
