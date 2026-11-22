import { useMinimizeOnScroll } from "expo-glass-tabs";
import { router, useIsFocused } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import Animated from "react-native-reanimated";
import { CallHistory } from "@/components/calls/call-history";
import { GlassInput } from "@/components/glassyui/glass-input";
import {
  GlassSegmentedControl,
  GlassSegmentedControlItem,
} from "@/components/glassyui/glass-segmented-control";
import { useMarmotWindow } from "@/components/messages/marmot-window";
import {
  Icon,
  IconButton,
  Ink,
  Screen,
  tapFeedback,
} from "@/components/ui/kit";
import { useAvatarVisibility } from "@/core/avatars/use-avatar";
import { CompactHeader, QuietState } from "@/components/ui/messenger-ui";
import { parseProfile, profileDetails } from "@/core/avatars/protocol";
import { parsePublicIdentity, toNpub } from "@/core/identity/keys";
import { marmot } from "@/core/marmot/native";
import { nip05Address } from "@/core/nostr/nip05";
import { useContacts } from "@/db/contacts";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";
import { useAppPreferences } from "@/stores/preferences";
import { space } from "@/theme";
import { PersonAvatar } from "./person-avatar";
import { usePerson, useVerifiedIdentifier } from "./use-person";

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
};
type DirectoryItem = { title: string } | PersonItem;

export function PeopleDirectory() {
  const onScroll = useMinimizeOnScroll();
  const { t } = useTranslation(namespaces);
  const separateCallsTab = useAppPreferences((state) => state.separateCallsTab);
  const [section, setSection] = useState<"contacts" | "calls">("contacts");
  const showCalls = !separateCallsTab && section === "calls";
  const { avatars, identity, lock, nip05, privacy, publicMetadata } =
    useLocal();
  const contacts = useContacts();
  const enabled = useChatsEnabled();
  const focused = useIsFocused() && !showCalls;
  const lockState = useSyncExternalStore(lock.subscribe, lock.getState);
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const { snapshot } = useMarmotWindow(openChats, enabled && !showCalls);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>();
  const searches = useRef(
    new Map<string, { result: Results; expires: number }>(),
  );
  const term = query.trim();
  const exact = parsePublicIdentity(term);
  const exactReference = exact ? term : undefined;
  const exactKey = exact?.key;
  const local = contacts.filter((row) => !privacy.isBlocked(row.publicKey));
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

  const savedPeople = filtered.filter((row) => row.publicKey !== exactKey);
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
    ...(savedPeople.length
      ? [
          { title: t("messenger:saved") },
          ...savedPeople.map(({ publicKey }) => ({ publicKey })),
        ]
      : []),
    ...(!term && recent.length
      ? [
          { title: t("messenger:recent") },
          ...recent.map((publicKey) => ({ publicKey })),
        ]
      : []),
  ];
  const visibility = useAvatarVisibility<DirectoryItem>((item) =>
    "publicKey" in item ? item.publicKey : "",
  );
  const noMatches =
    term &&
    !remote.length &&
    !filtered.length &&
    (current?.state === "complete" ||
      term.length > 80 ||
      /^(?:nostr:|nsec1|ncryptsec1|npub1|nprofile1)/i.test(term));
  return (
    <Screen tab scroll={false}>
      <View style={styles.header}>
        <CompactHeader title={t("messenger:people")}>
          {!showCalls && (
            <IconButton
              icon="qr"
              label={t("contacts:scanQr")}
              onPress={() => router.push("/scan")}
            />
          )}
        </CompactHeader>
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
      {showCalls ? (
        <CallHistory onScroll={onScroll} />
      ) : (
        <Animated.FlatList
          data={items}
          {...visibility}
          keyExtractor={(item) =>
            "publicKey" in item ? item.publicKey : item.title
          }
          renderItem={({ item }) =>
            "publicKey" in item ? (
              <PersonRow {...item} />
            ) : (
              <Ink
                kind="caption"
                muted
                accessibilityRole="header"
                style={styles.section}
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
              <ActivityIndicator accessibilityLabel={t("common:opening")} />
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
    </Screen>
  );
}

function PersonRow({ publicKey, reference, showVerification }: PersonItem) {
  const { t } = useTranslation(namespaces);
  const { contact, profile, photo, name } = usePerson(publicKey, false);
  const { about, nip05 } = profileDetails(profile?.fields);
  const verified = useVerifiedIdentifier(
    showVerification ? nip05 : undefined,
    publicKey,
  );
  const address = toNpub(publicKey);
  return (
    <Pressable
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={t("contacts:openProfile", { name })}
      onPress={() => {
        tapFeedback();
        router.push({
          pathname: "/person/[key]",
          params: { key: publicKey, ...(reference ? { reference } : {}) },
        });
      }}
    >
      <PersonAvatar
        publicKey={publicKey}
        name={name}
        photo={photo}
        hasName={Boolean(contact?.name || profile?.name)}
      />
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
    </Pressable>
  );
}
const styles = StyleSheet.create({
  header: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  list: { paddingHorizontal: space.lg, paddingBottom: space.lg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 57,
    paddingVertical: space.sm,
  },
  info: { gap: 2, flex: 1 },
  section: { paddingTop: space.md, paddingBottom: space.xs, fontWeight: "600" },
});
