import { CircularList } from "@/components/ui/molecules/circular-list";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import Transition from "react-native-screen-transitions";
import { useMinimizeOnScroll } from "expo-glass-tabs";
import { router, useFocusEffect, useIsFocused } from "expo-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, StyleSheet, View, useWindowDimensions } from "react-native";
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
import { useMarmotWindow } from "@/components/messages/marmot-window";
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
import { CompactHeader, QuietState } from "@/components/ui/messenger-ui";
import { parseProfile, profileDetails } from "@/core/avatars/protocol";
import { parsePublicIdentity, toNpub } from "@/core/identity/keys";
import { marmot } from "@/core/marmot/native";
import { nip05Address } from "@/core/nostr/nip05";
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
import { PersonAvatar } from "./person-avatar";
import { usePublicProfile, useVerifiedIdentifier } from "./use-person";

const openChats = () => marmot.openChatList("chats");
type Results = {
  query: string;
  keys: string[];
  state: "loading" | "complete" | "unavailable";
};

type PersonItem = {
  publicKey: string;
  reference?: string;
  showVerification?: boolean;
  separated?: boolean;
};
type SavedContact = ReturnType<typeof useContacts>[number];
type DirectoryItem =
  { title: string; separated?: boolean } | PersonItem | { carousel: true };

export function PeopleDirectory() {
  const onScroll = useMinimizeOnScroll();
  const { t, i18n } = useTranslation(namespaces);
  const { colors } = useTheme();
  const setPeopleFabVisible = useTabFabVisibility()?.setPeopleVisible;
  const favoritesDisplay = useAppPreferences((state) => state.favoritesDisplay);
  const separateCallsTab = useAppPreferences((state) => state.separateCallsTab);
  const [section, setSection] = useState<"contacts" | "calls">("contacts");
  const showCalls = !separateCallsTab && section === "calls";
  useLayoutEffect(() => {
    setPeopleFabVisible?.(!showCalls);
  }, [setPeopleFabVisible, showCalls]);
  const { avatars, db, identity, lock, nip05, privacy, publicMetadata } =
    useLocal();
  const contacts = useContacts();
  const enabled = useChatsEnabled();
  const focused = useIsFocused() && !showCalls;
  const lockState = useSyncExternalStore(lock.subscribe, lock.getState);
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const { snapshot } = useMarmotWindow(openChats, enabled && !showCalls);
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
  const [results, setResults] = useState<Results>();
  const searches = useRef(
    new Map<string, { result: Results; expires: number }>(),
  );
  const term = query.trim();
  const exact = parsePublicIdentity(term);
  const exactReference = exact ? term : undefined;
  const exactKey = exact?.key;
  const local = contacts.filter((row) => !privacy.isBlocked(row.publicKey));
  const contactsByKey = new Map(
    local.map((contact) => [contact.publicKey, contact]),
  );
  const filtered = term
    ? local.filter((row) => {
        const profile = avatars.profile(row.publicKey);
        return [
          row.name,
          profile?.name,
          profileDetails(profile?.fields).nip05,
          toNpub(row.publicKey),
        ].some((value) => value?.toLowerCase().includes(term.toLowerCase()));
      })
    : local;
  filtered.sort(
    (a, b) =>
      Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name),
  );
  const recent = [
    ...new Set(
      snapshot?.rows.flatMap((row) =>
        row.peer && row.membership === "member" && !row.invited
          ? [row.peer]
          : [],
      ),
    ),
  ]
    .filter(
      (key) =>
        key !== identity.publicKey &&
        !local.some((row) => row.publicKey === key) &&
        !privacy.isBlocked(key),
    )
    .slice(0, 8);

  useEffect(() => {
    if (
      !focused ||
      lockState.locked ||
      !lockState.active ||
      exactKey ||
      term.length < 2
    )
      return;
    if (
      term.length > 80 ||
      /^(?:nostr:|nsec1|ncryptsec1|npub1|nprofile1)|[\r\n]/i.test(term)
    )
      return;
    const cache = searches.current;
    const controller = new AbortController();
    let stop: (() => void) | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const keys = new Set<string>();
    const display = (state: Results["state"]) => {
      if (controller.signal.aborted) return;
      const result = { query: term, keys: [...keys], state };
      if (state === "complete") {
        if (cache.size >= 12) {
          const first = cache.keys().next().value;
          if (first) cache.delete(first);
        }
        cache.set(term, { result, expires: Date.now() + 60_000 });
      }
      setResults(result);
    };
    const timer = setTimeout(() => {
      const saved = cache.get(term);
      if (saved && saved.expires > Date.now()) {
        setResults(saved.result);
        return;
      }
      display("loading");
      if (term.includes("@")) {
        if (!nip05Address(term)) {
          display("complete");
          return;
        }
        void nip05
          .resolve(term, controller.signal)
          .then((key) => {
            if (key) keys.add(key);
            display("complete");
          })
          .catch(() => display("unavailable"));
        return;
      }
      deadline = setTimeout(() => {
        stop?.();
        display(keys.size ? "complete" : "unavailable");
      }, 7_000);
      stop = publicMetadata.searchProfiles(
        term,
        (event, author) => {
          if (
            controller.signal.aborted ||
            keys.size >= 24 ||
            privacy.isBlocked(author)
          )
            return;
          const profile = parseProfile(event, author);
          if (!profile) return;
          const fields = profileDetails(profile.fields);
          const normalized = term.toLowerCase();
          if (
            ![profile.name, fields.name, fields.about, fields.nip05].some(
              (value) => value?.toLowerCase().includes(normalized),
            )
          )
            return;
          avatars.ingest(event, author);
          keys.add(author);
          display("loading");
        },
        () => {
          clearTimeout(deadline);
          display("complete");
        },
      );
      if (!stop) {
        clearTimeout(deadline);
        display("unavailable");
      }
    }, 480);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
      stop?.();
    };
  }, [
    avatars,
    exactKey,
    focused,
    lockState.active,
    lockState.locked,
    nip05,
    privacy,
    publicMetadata,
    term,
  ]);

  const current = results?.query === term ? results : undefined;
  const remote = exactKey
    ? [exactKey]
    : (current?.keys ?? []).filter(
        (key) =>
          !filtered.some((row) => row.publicKey === key) &&
          !privacy.isBlocked(key),
      );

  const favorites = term ? [] : filtered.filter(({ favorite }) => favorite);
  const savedPeople = filtered.filter(
    (row) => row.publicKey !== exactKey && (term || !row.favorite),
  );
  const normalFavorites = favorites.length > 0 && favoritesDisplay === "normal";
  const items: DirectoryItem[] = [
    ...(term && remote.length
      ? [
          ...(!exactKey ? [{ title: t("messenger:results") }] : []),
          ...remote.map((publicKey) => ({
            publicKey,
            reference: exactReference,
            showVerification: true,
          })),
        ]
      : []),
    ...(favorites.length
      ? favoritesDisplay === "cool"
        ? [{ carousel: true } as const]
        : favorites
      : []),
    ...savedPeople.map(({ publicKey }, index) => ({
      publicKey,
      separated: normalFavorites && index === 0,
    })),
    ...(!term && recent.length
      ? [
          {
            title: t("messenger:recent"),
            separated: normalFavorites && !savedPeople.length,
          },
          ...recent.map((publicKey) => ({ publicKey })),
        ]
      : []),
  ];
  const { onViewableItemsChanged: onDirectoryViewable, viewabilityConfig } =
    useAvatarVisibility<DirectoryItem>((item) =>
      "publicKey" in item ? item.publicKey : "",
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
  const noMatches =
    term &&
    !remote.length &&
    !filtered.length &&
    (current?.state === "complete" ||
      term.length > 80 ||
      /^(?:nostr:|nsec1|ncryptsec1|npub1|nprofile1)/i.test(term));
  const menuContact = local.find((row) => row.publicKey === contactMenu?.key);
  const menuName =
    menuContact &&
    nameOrAddress(
      menuContact.name || avatars.profile(menuContact.publicKey)?.name,
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
              setSection(next);
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
            accessibilityLabel={t("messenger:find")}
            compact
            placeholder={t("messenger:searchHint")}
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
              "publicKey" in item
                ? item.publicKey
                : "carousel" in item
                  ? "favorites-carousel"
                  : item.title
            }
            renderItem={({ item }) =>
              "publicKey" in item ? (
                <PersonRow
                  {...item}
                  contact={contactsByKey.get(item.publicKey)}
                  onContactActions={openContactMenu}
                />
              ) : "carousel" in item ? (
                <FavoriteCarousel
                  favorites={favorites}
                  visible={carouselVisible}
                  rtl={rtl}
                  onContactActions={openContactMenu}
                />
              ) : (
                <Ink
                  kind="caption"
                  muted
                  accessibilityRole="header"
                  style={[
                    styles.section,
                    item.separated && styles.sectionSeparated,
                  ]}
                >
                  {item.title}
                </Ink>
              )
            }
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            onScroll={onScroll}
            scrollEventThrottle={16}
            contentContainerStyle={styles.list}
            ListFooterComponent={
              term && current?.state === "loading" ? (
                <LoadingSkeleton layout="person" label={t("common:opening")} />
              ) : term && current?.state === "unavailable" ? (
                <Ink muted>{t("messenger:searchUnavailable")}</Ink>
              ) : noMatches ? (
                <Ink muted>{t("messenger:noResults")}</Ink>
              ) : !term && !local.length && !recent.length ? (
                <QuietState
                  icon="person"
                  title={t("messenger:find")}
                  detail={t("messenger:noPeople")}
                />
              ) : undefined
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
  const { relays, publicMetadata } = useLocal();
  const canLookUpNames = Boolean(
    useSyncExternalStore(relays.subscribe, publicMetadata.profileRelayKey),
  );
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
          publicKey={person.publicKey}
          contact={person}
          tile
          lookUpName={canLookUpNames}
          onContactActions={onContactActions}
        />
      )}
    />
  );
}

function PersonRow({
  publicKey,
  reference,
  showVerification,
  separated,
  contact,
  lookUpName = false,
  onContactActions,
  tile = false,
}: PersonItem & {
  contact?: SavedContact;
  lookUpName?: boolean;
  onContactActions: (key: string) => void;
  tile?: boolean;
}) {
  const { t } = useTranslation(namespaces);
  const profile = usePublicProfile(publicKey);
  const photo = useAvatar(publicKey, false);
  const knownName = contact?.name.trim() || profile?.name;
  const name =
    knownName ||
    (tile ? t("contacts:unnamed") : nameOrAddress(undefined, publicKey));
  const { about, nip05 } = profileDetails(profile?.fields);
  const verified = useVerifiedIdentifier(
    showVerification ? nip05 : undefined,
    publicKey,
  );
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
      onLongPress={contact ? () => onContactActions(publicKey) : undefined}
      accessibilityActions={
        contact
          ? [{ name: "longpress", label: t("contacts:contactActions") }]
          : undefined
      }
      onAccessibilityAction={
        contact
          ? (event) => {
              if (event.nativeEvent.actionName === "longpress")
                onContactActions(publicKey);
            }
          : undefined
      }
      onPress={() => {
        tapFeedback();
        router.push({
          pathname: "/person/[key]",
          params: {
            key: publicKey,
            origin: `person:${publicKey}`,
            ...(reference ? { reference } : {}),
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
              {verified
                ? nip05
                : about || `${address.slice(0, 15)}…${address.slice(-5)}`}
            </Ink>
          </View>
          {contact?.favorite ? (
            <Icon name="favorite" size={18} />
          ) : contact ? (
            <Icon name="check" size={18} />
          ) : (
            <Icon name="next" size={18} />
          )}
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
        highlight={colors.accentSoft}
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
  section: { paddingTop: space.md, paddingBottom: space.xs, fontWeight: "600" },
});
