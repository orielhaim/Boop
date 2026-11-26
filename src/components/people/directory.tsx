import { CircularList } from "@/components/ui/molecules/circular-list";
import Transition from "react-native-screen-transitions";
import { useMinimizeOnScroll } from "@/components/navigation/dock-motion";
import { router, useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, View, useWindowDimensions } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTabFabVisibility } from "@/components/navigation/tab-fab-visibility";
import { CallHistory } from "@/components/calls/call-history";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { GlassInput } from "@/components/glassyui/glass-input";
import {
  GlassSegmentedControl,
  GlassSegmentedControlItem,
} from "@/components/glassyui/glass-segmented-control";
import {
  Action,
  Icon,
  Ink,
  Row,
  Screen,
  tapFeedback,
} from "@/components/ui/kit";
import {
  Shimmer,
  useShimmerProgress,
} from "@/components/ui/molecules/Shimmer/Shimmer";
import { useAvatar, useAvatarVisibility } from "@/core/avatars/use-avatar";
import { IllustratedEmptyState } from "@/components/ui/illustrated-empty-state";
import { CompactHeader } from "@/components/ui/messenger-ui";
import { toNpub } from "@/core/identity/keys";
import {
  contactByKey,
  removeContact,
  updateContactPreferences,
} from "@/db/queries";
import { useContacts, nameOrAddress } from "@/db/contacts";
import { directionFor, namespaces, resolveLanguage } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";
import { useAppPreferences } from "@/stores/preferences";
import { space, useTheme } from "@/theme";
import { ContactCardArtwork } from "./contact-card-artwork";
import { PersonAvatar } from "./person-avatar";
import { usePublicProfile } from "./use-person";

type PersonItem = {
  contact: SavedContact;
  separated?: boolean;
};
type SavedContact = ReturnType<typeof useContacts>[number];
type DirectoryItem = PersonItem | { carousel: true };

export function PeopleDirectory() {
  const onScroll = useMinimizeOnScroll();
  const { t, i18n } = useTranslation(namespaces);
  const { colors } = useTheme();
  const tabs = useTabFabVisibility();
  const favoritesDisplay = useAppPreferences((state) => state.favoritesDisplay);
  const separateCallsTab = useAppPreferences((state) => state.separateCallsTab);
  const section = tabs?.peopleSection ?? "contacts";
  const showCalls = !separateCallsTab && section === "calls";
  const { db, lock, privacy, profiles } = useLocal();
  const contacts = useContacts();
  const enabled = useChatsEnabled();
  const focused = useIsFocused() && !showCalls;
  const lockState = useSyncExternalStore(lock.subscribe, lock.getState);
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const [query, setQuery] = useState("");
  const [carouselVisible, setCarouselVisible] = useState(false);
  const [contactMenu, setContactMenu] = useState<{
    key: string;
    kind: "actions" | "confirmRemoval";
  }>();
  const [contactActionError, setContactActionError] = useState(false);
  useFocusEffect(useCallback(() => () => setContactMenu(undefined), []));
  useEffect(
    () =>
      lock.subscribe(() => {
        const state = lock.getState();
        if (state.locked || !state.active) setContactMenu(undefined);
      }),
    [lock],
  );
  const term = query.trim().toLowerCase();
  const local = contacts.filter((row) => !privacy.isBlocked(row.publicKey));
  const filtered = term
    ? local.filter((row) => {
        const profile = profiles.profile(row.publicKey);
        return [
          row.name,
          profile?.name,
          profile?.nip05,
          row.publicKey,
          toNpub(row.publicKey),
        ].some((value) => value?.toLowerCase().includes(term));
      })
    : local;
  filtered.sort(
    (a, b) =>
      Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name),
  );
  const favorites = term ? [] : filtered.filter(({ favorite }) => favorite);
  const savedPeople = term
    ? filtered
    : filtered.filter(({ favorite }) => !favorite);
  const boringFavorites = favorites.length > 0 && favoritesDisplay === "boring";
  const items: DirectoryItem[] = [
    ...(favorites.length
      ? favoritesDisplay === "cool"
        ? [{ carousel: true } as const]
        : favorites.map((contact) => ({ contact }))
      : []),
    ...savedPeople.map((contact, index) => ({
      contact,
      separated: boringFavorites && index === 0,
    })),
  ];
  const { onViewableItemsChanged: onDirectoryViewable, viewabilityConfig } =
    useAvatarVisibility<DirectoryItem>((item) =>
      "contact" in item ? item.contact.publicKey : "",
    );
  const toggleDirectoryVisibility = useCallback(
    (event: Parameters<typeof onDirectoryViewable>[0]) => {
      onDirectoryViewable(event);
      setCarouselVisible(
        event.viewableItems.some(
          ({ item, isViewable }) => isViewable && "carousel" in item,
        ),
      );
    },
    [onDirectoryViewable, setCarouselVisible],
  );
  const rtl = directionFor(resolveLanguage(i18n.resolvedLanguage)) === "rtl";
  const menuContact = local.find((row) => row.publicKey === contactMenu?.key);
  const menuName =
    menuContact &&
    nameOrAddress(
      menuContact.name || profiles.profile(menuContact.publicKey)?.name,
      menuContact.publicKey,
    );
  const menuOpen =
    focused && lockState.active && !lockState.locked && !!menuContact;

  function openContactMenu(key: string) {
    if (!local.some((row) => row.publicKey === key)) return;
    tapFeedback();
    Keyboard.dismiss();
    setContactActionError(false);
    setContactMenu({ key, kind: "actions" });
  }

  function applyContactAction(action: "favorite" | "remove" | "message") {
    if (!menuContact) return;
    const key = menuContact.publicKey;
    const state = lock.getState();
    if (state.locked || !state.active || privacy.isBlocked(key)) {
      setContactMenu(undefined);
      return;
    }
    try {
      if (action === "message") {
        if (enabled && contactByKey(db, key).get()) {
          setContactMenu(undefined);
          router.push({ pathname: "/chat/[key]", params: { key } });
        }
        return;
      }
      db.transaction((tx) => {
        const saved = contactByKey(tx, key).get();
        if (!saved) return;
        if (action === "remove") removeContact(tx, key);
        else updateContactPreferences(tx, key, { favorite: !saved.favorite });
      });
      setContactMenu(undefined);
    } catch {
      setContactActionError(true);
    }
  }

  return (
    <Screen tab scroll={false}>
      <View style={styles.header}>
        <CompactHeader title={t("messenger:people")} />
        {!separateCallsTab && (
          <GlassSegmentedControl
            value={section}
            onValueChange={(next) => {
              if (next !== "contacts" && next !== "calls") return;
              if (next === "calls") Keyboard.dismiss();
              tapFeedback();
              tabs?.setPeopleSection(next);
            }}
          >
            <GlassSegmentedControlItem value="contacts">
              {t("navigation:contacts")}
            </GlassSegmentedControlItem>
            <GlassSegmentedControlItem value="calls">
              {t("navigation:calls")}
            </GlassSegmentedControlItem>
          </GlassSegmentedControl>
        )}
        {!showCalls && (
          <GlassInput
            accessibilityLabel={t("contacts:search")}
            compact
            placeholder={t("contacts:search")}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={1024}
          />
        )}
      </View>
      <View style={styles.body}>
        {showCalls ? (
          <CallHistory onScroll={onScroll} />
        ) : (
          <Animated.FlatList
            data={items}
            viewabilityConfig={viewabilityConfig}
            onViewableItemsChanged={toggleDirectoryVisibility}
            keyExtractor={(item) =>
              "contact" in item ? item.contact.publicKey : "favorites-carousel"
            }
            renderItem={({ item }) =>
              "contact" in item ? (
                <PersonRow {...item} onContactActions={openContactMenu} />
              ) : (
                <FavoriteCarousel
                  favorites={favorites}
                  visible={carouselVisible}
                  rtl={rtl}
                  onContactActions={openContactMenu}
                />
              )
            }
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            onScroll={onScroll}
            scrollEventThrottle={16}
            contentContainerStyle={[
              styles.list,
              items.length === 0 && !term && styles.emptyList,
            ]}
            ListEmptyComponent={
              term ? (
                <Ink muted>{t("contacts:noResults")}</Ink>
              ) : (
                <IllustratedEmptyState
                  artwork={<ContactCardArtwork />}
                  title={t("contacts:empty")}
                  detail={t("contacts:emptyHint")}
                />
              )
            }
          />
        )}
      </View>
      <GlassSheet
        open={menuOpen}
        onOpenChange={(open) => {
          if (!open) setContactMenu(undefined);
        }}
      >
        <GlassSheetContent>
          {contactMenu?.kind === "confirmRemoval" ? (
            <>
              <GlassSheetTitle>{t("messenger:removePerson")}</GlassSheetTitle>
              <Action
                variant="prominent"
                onPress={() => applyContactAction("remove")}
              >
                {t("messenger:removePerson")}
              </Action>
              <Action
                variant="soft"
                onPress={() => {
                  setContactActionError(false);
                  setContactMenu({ key: contactMenu.key, kind: "actions" });
                }}
              >
                {t("common:cancel")}
              </Action>
            </>
          ) : menuContact ? (
            <>
              <GlassSheetTitle>{menuName}</GlassSheetTitle>
              {enabled && (
                <Row
                  leading={<Icon name="chat" />}
                  title={t("contacts:message")}
                  onPress={() => applyContactAction("message")}
                />
              )}
              <Row
                leading={<Icon name="favorite" />}
                title={t(
                  menuContact.favorite
                    ? "contacts:removeFavorite"
                    : "contacts:addFavorite",
                )}
                onPress={() => applyContactAction("favorite")}
              />
              <Row
                leading={<Icon name="erase" color={colors.danger} />}
                title={t("messenger:removePerson")}
                onPress={() => {
                  setContactActionError(false);
                  setContactMenu({
                    key: menuContact.publicKey,
                    kind: "confirmRemoval",
                  });
                }}
              />
            </>
          ) : null}
          {contactActionError && (
            <Ink accessibilityRole="alert" accessibilityLiveRegion="polite">
              {t("security:privacyWriteFailed")}
            </Ink>
          )}
        </GlassSheetContent>
      </GlassSheet>
    </Screen>
  );
}

function FavoriteCarousel({
  favorites,
  visible,
  rtl,
  onContactActions,
}: {
  favorites: SavedContact[];
  visible: boolean;
  rtl: boolean;
  onContactActions: (key: string) => void;
}) {
  const { reduceMotion } = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const visibility = useAvatarVisibility<SavedContact>(
    (person) => person.publicKey,
    visible,
  );
  return (
    <CircularList
      key={favorites.length === 1 ? "single" : "multiple"}
      data={favorites}
      initialWidth={width - insets.left - insets.right - space.lg * 2}
      rtl={rtl}
      reduceMotion={reduceMotion}
      keyExtractor={(person) => person.publicKey}
      {...visibility}
      renderItem={(person) => (
        <PersonRow
          contact={person}
          tile
          lookUpName={visible}
          onContactActions={onContactActions}
        />
      )}
    />
  );
}

function PersonRow({
  separated,
  contact,
  lookUpName = false,
  onContactActions,
  tile = false,
}: PersonItem & {
  lookUpName?: boolean;
  onContactActions: (key: string) => void;
  tile?: boolean;
}) {
  const { t } = useTranslation(namespaces);
  const { publicKey } = contact;
  const profile = usePublicProfile(publicKey);
  const photo = useAvatar(publicKey, false);
  const knownName = contact.name.trim() || profile?.name;
  const name =
    knownName ||
    (tile ? t("contacts:unnamed") : nameOrAddress(undefined, publicKey));
  const about = profile?.about;
  const address = toNpub(publicKey);
  return (
    <Transition.Boundary
      id={`person:${publicKey}`}
      style={[
        tile ? styles.tile : styles.row,
        separated && styles.sectionSeparated,
      ]}
      accessibilityRole="button"
      accessibilityLabel={t("contacts:openProfile", { name })}
      onLongPress={() => onContactActions(publicKey)}
      accessibilityActions={[
        { name: "longpress", label: t("contacts:contactActions") },
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "longpress")
          onContactActions(publicKey);
      }}
      onPress={() => {
        tapFeedback();
        router.push({
          pathname: "/person/[key]",
          params: {
            key: publicKey,
            origin: `person:${publicKey}`,
          },
        });
      }}
    >
      <Transition.Boundary.Target>
        <PersonAvatar
          publicKey={publicKey}
          name={name}
          photo={photo}
          hasName={Boolean(knownName)}
          size={tile ? "lg" : "md"}
        />
      </Transition.Boundary.Target>
      {tile ? (
        !knownName && !profile && lookUpName ? (
          <PendingFavoriteName fallback={name} />
        ) : (
          <Ink kind="caption" numberOfLines={2} style={styles.tileLabel}>
            {name}
          </Ink>
        )
      ) : (
        <>
          <View style={styles.info}>
            <Ink kind="label" numberOfLines={1}>
              {name}
            </Ink>
            <Ink kind="caption" muted numberOfLines={1}>
              {about || `${address.slice(0, 15)}…${address.slice(-5)}`}
            </Ink>
          </View>
          <Icon name={contact.favorite ? "favorite" : "check"} size={18} />
        </>
      )}
    </Transition.Boundary>
  );
}
function PendingFavoriteName({ fallback }: { fallback: string }) {
  const { colors, reduceMotion } = useTheme();
  const [waiting, setWaiting] = useState(true);
  const progress = useShimmerProgress(waiting && !reduceMotion);
  useEffect(() => {
    const timer = setTimeout(() => setWaiting(false), 2000);
    return () => clearTimeout(timer);
  }, []);
  return waiting ? (
    <View
      style={styles.pendingLabel}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Shimmer
        background={colors.line}
        highlight={colors.selected}
        progress={reduceMotion ? undefined : progress}
        rtl={false}
        style={styles.pendingLine}
      />
    </View>
  ) : (
    <Ink kind="caption" numberOfLines={2} style={styles.tileLabel}>
      {fallback}
    </Ink>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  body: { flex: 1 },
  list: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: 72,
  },
  emptyList: { flexGrow: 1, paddingBottom: space.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 57,
    paddingVertical: space.sm,
  },
  info: { gap: 2, flex: 1 },
  tile: { alignItems: "center", gap: space.xs, paddingHorizontal: space.xs },
  tileLabel: { textAlign: "center" },
  pendingLabel: { minHeight: 18, justifyContent: "center" },
  pendingLine: { width: 56, height: 10, borderRadius: 8 },
  sectionSeparated: { marginTop: space.sm },
});
