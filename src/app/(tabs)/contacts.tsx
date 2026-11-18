import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import { useRef, useState } from "react";
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
import { byNameOrKey, useContacts } from "@/db/contacts";
import { radius, space, useTheme } from "@/theme";

export default function Contacts() {
  const [query, search] = useState("");
  const [filter, setFilter] = useState("all");
  const [expandedKey, setExpandedKey] = useState<string>();
  const contacts = useContacts().filter(
    (contact) =>
      (filter !== "favorites" || contact.favorite) &&
      byNameOrKey(query, contact.publicKey, contact.name),
  );
  const add = () => router.push("/contact/new");

  return (
    <Screen tab scroll={false}>
      <View style={styles.top}>
        <Header title="Contacts">
          <IconButton
            icon="add"
            label="Add contact"
            tone="accent"
            onPress={add}
          />
        </Header>
        <Search
          value={query}
          onChangeText={search}
          accessibilityLabel="Search contacts"
          placeholder="Search contacts"
        />
        <GlassSegmentedControl
          value={filter}
          onValueChange={setFilter}
          accessibilityLabel="Contact filter"
        >
          <GlassSegmentedControlItem value="all">
            All contacts
          </GlassSegmentedControlItem>
          <GlassSegmentedControlItem value="favorites">
            Favorites
          </GlassSegmentedControlItem>
        </GlassSegmentedControl>
      </View>
      <FlashList
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
                ? "No contacts found"
                : filter === "favorites"
                  ? "No favorites yet"
                  : "Your contacts live here"
            }
            detail={
              query
                ? "Try another name or Boop address."
                : filter === "favorites"
                  ? "Star a contact from their profile."
                  : "Add someone using their Boop address or QR code."
            }
          >
            {!query && filter === "all" && (
              <Action onPress={add}>Add contact</Action>
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
  { label: "Info", icon: "info", route: "/contact/[key]" },
  { label: "Call", icon: "phone", route: "/call/[key]" },
  { label: "Message", icon: "chat", route: "/chat/[key]" },
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
  const { colors } = useTheme();
  const swipeable = useRef<SwipeableMethods>(null);
  const { name, publicKey, avatarUrl, favorite } = contact;
  return (
    <View
      style={[
        styles.item,
        { borderColor: colors.line, backgroundColor: colors.surface },
      ]}
    >
      <Swipeable
        ref={swipeable}
        rightThreshold={64}
        overshootRight={false}
        dragOffsetFromRight={-14}
        renderRightActions={() => (
          <View
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.quickCall, { backgroundColor: colors.outgoing }]}
          >
            <Icon name="phone" color={colors.outgoingInk} />
            <Ink kind="caption" style={{ color: colors.outgoingInk }}>
              Call
            </Ink>
          </View>
        )}
        onSwipeableOpen={(direction) => {
          swipeable.current?.reset();
          if (direction === SwipeDirection.LEFT)
            router.push({
              pathname: "/call/[key]",
              params: { key: publicKey },
            });
        }}
      >
        <View style={{ backgroundColor: colors.surface }}>
          <Row
            leading={<Avatar name={name} uri={avatarUrl} />}
            title={name}
            trailing={
              <View style={styles.indicators}>
                {favorite ? <Icon name="favorite" size={16} /> : null}
                <Icon name={expanded ? "collapse" : "expand"} size={18} />
              </View>
            }
            expanded={expanded}
            onPress={onToggle}
          />
        </View>
      </Swipeable>
      {expanded ? (
        <View style={[styles.actions, { borderTopColor: colors.line }]}>
          {actions.map(({ label, icon, route }) => (
            <View key={label} style={styles.action}>
              <IconButton
                icon={icon}
                label={`${label} · ${name}`}
                onPress={() =>
                  router.push({ pathname: route, params: { key: publicKey } })
                }
              />
              <Ink kind="caption" muted>
                {label}
              </Ink>
            </View>
          ))}
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
