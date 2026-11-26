import { ScreenHeader } from "@/components/navigation/screen-header";
import Transition from "react-native-screen-transitions";
import {
  router,
  useFocusEffect,
  useIsFocused,
  useNavigation,
} from "expo-router";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  Linking,
  useWindowDimensions,
  View,
} from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { AvatarPicker } from "@/components/avatars/picker";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { GlassInput } from "@/components/glassyui/glass-input";
import { ProfileElement } from "@/components/navigation/profile-elements";
import {
  useDismissProfile,
  useSharedProfileBack,
} from "@/components/navigation/profile-reopen";
import { SharedMediaLibrary } from "@/components/shared-media/library";
import {
  ProfileTabs,
  type ProfileTab,
} from "@/components/shared-media/profile-tabs";
import { ActionMenu, type ActionMenuProps } from "@/components/ui/action-menu";
import { useDialog } from "@/components/ui/dialog";
import { GlassBackButton } from "@/components/ui/back-button";
import { Action, Empty, Icon, Ink, Screen } from "@/components/ui/kit";
import { CompactAction, QuietState } from "@/components/ui/messenger-ui";
import { useBlockAction } from "@/components/ui/privacy-actions";
import { AuraLift } from "@/components/ui/organisms/aura-lift";
import { useAnimateScrollView } from "@/components/ui/templates/parallax-header/hooks/useAnimatedScrollView";
import { useAvatar } from "@/core/avatars/use-avatar";
import { parsePublicIdentity, toNpub } from "@/core/identity/keys";
import { marmot } from "@/core/marmot/native";
import { nameOrAddress } from "@/db/contacts";
import {
  contactByKey,
  removeContact,
  saveContact,
  updateContactPreferences,
} from "@/db/queries";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";
import { AddressSheetContent } from "./address-sheet";
import { PersonCallHistory, PersonGroups } from "./person-context";
import { PersonAvatar } from "./person-avatar";
import { ProfileBannerArtwork } from "./profile-banner-artwork";
import { usePersonIdentity, useVerifiedIdentifier } from "./use-person";

export function PersonProfile({
  publicKey,
  hint,
  morph,
}: {
  publicKey: string | null;
  hint?: string;
  morph?: string;
}) {
  const { t } = useTranslation(namespaces);
  return publicKey ? (
    <ProfileContent
      key={publicKey}
      publicKey={publicKey}
      hint={hint}
      morph={morph}
    />
  ) : (
    <Screen
      navigationHeader={<ScreenHeader title={t("contacts:unavailable")} />}
    >
      <Empty
        icon="person"
        title={t("contacts:unavailable")}
        detail={t("contacts:invalid")}
      />
    </Screen>
  );
}

function ProfileContent({
  publicKey,
  hint,
  morph,
}: {
  publicKey: string;
  hint?: string;
  morph?: string;
}) {
  const { height } = useWindowDimensions();
  const bannerHeight = Math.max(1, Math.min(148, height * 0.2));
  const bannerOverlap = Math.min(70, Math.max(0, bannerHeight - space.sm));
  const profileMotion = useAnimateScrollView(bannerHeight);
  const mediaMotion = useAnimateScrollView(bannerHeight);
  const { t } = useTranslation(namespaces);
  const dialog = useDialog();
  const { avatars, db, lock, marmotSession, privacy, profiles } = useLocal();
  const { colors, reduceMotion, reduceTransparency } = useTheme();
  const focused = useIsFocused();
  const navigation = useNavigation();
  const dismissProfile = useDismissProfile(morph);
  const sharedBack = useSharedProfileBack(morph);
  const leaving = useRef(false);
  const lockState = useSyncExternalStore(lock.subscribe, lock.getState);
  const privacyRevision = useSyncExternalStore(
    privacy.subscribe,
    privacy.revision,
  );
  const {
    contact: observedContact,
    profile,
    name: observedName,
  } = usePersonIdentity(publicKey);
  const photo = useAvatar(publicKey, true, false, true);
  const canViewPhoto = Boolean(photo);
  const banner = useAvatar(publicKey, true, true, true);
  const block = useBlockAction(publicKey);
  const restricted = privacy.isBlocked(publicKey);
  const verified = useVerifiedIdentifier(
    focused && !restricted ? profile?.nip05 : undefined,
    publicKey,
  );
  const chatsEnabled = useChatsEnabled();
  const sessionStatus = useSyncExternalStore(
    marmotSession.subscribe,
    marmotSession.status,
  );
  const sessionRevision = useSyncExternalStore(
    marmotSession.subscribe,
    marmotSession.revision,
  );
  const address = toNpub(publicKey);
  const [addressOpen, setAddressOpen] = useState(false);
  const [contactEdit, setContactEdit] = useState<
    | { kind: "rename"; name: string }
    | {
        kind: "saved";
        added: boolean;
        commit?: {
          row: NonNullable<typeof observedContact>;
          previous: typeof observedContact;
        };
      }
  >();
  const contactEditor = contactEdit?.kind === "saved" ? undefined : contactEdit;
  // Use the committed row until the live query delivers its next snapshot.
  const commit = contactEdit?.kind === "saved" ? contactEdit.commit : undefined;
  if (
    contactEdit?.kind === "saved" &&
    contactEdit.commit &&
    contactEdit.commit.previous !== observedContact
  ) {
    setContactEdit({ kind: "saved", added: contactEdit.added });
  }
  const committedContact = commit?.row;
  const contact = committedContact ?? observedContact;
  const name = committedContact
    ? nameOrAddress(committedContact.name || profile?.name, publicKey)
    : observedName;
  const [contactEditorError, setContactEditorError] = useState(false);
  const [picking, setPicking] = useState(false);
  const imagesRequested = useSyncExternalStore(
    useCallback(
      (notify) => avatars.subscribe(publicKey, notify),
      [avatars, publicKey],
    ),
    () => avatars.profileImagesRequested(publicKey),
  );
  const [notice, setNotice] = useState("");
  const [conversationRecord, setConversationRecord] = useState<{
    peer: string;
    revision: number;
    privacyRevision: number;
    id: string | null;
  }>();
  const [tabChoice, setSelectedTab] = useState<"media" | "groups">("groups");
  const [visitedMedia, setVisitedMedia] = useState(false);
  const mediaScrollPosition = useRef(0);
  const mediaConversation =
    conversationRecord?.peer === publicKey &&
    conversationRecord.revision === sessionRevision &&
    conversationRecord.privacyRevision === privacyRevision &&
    !restricted
      ? conversationRecord.id
      : undefined;
  const mediaAvailable =
    typeof mediaConversation === "string" &&
    chatsEnabled &&
    lockState.active &&
    !lockState.locked &&
    sessionStatus === "ready";
  const hasMediaTab = chatsEnabled && !restricted;
  const selectedTab = hasMediaTab ? tabChoice : "groups";
  const showingMedia = selectedTab === "media";
  const showingGroups = selectedTab === "groups";
  const showingLibrary = showingMedia && mediaAvailable;

  useEffect(() => {
    let current = true;
    if (restricted) return;
    if (
      !chatsEnabled ||
      !focused ||
      !lockState.active ||
      lockState.locked ||
      sessionStatus !== "ready"
    )
      return () => {
        current = false;
      };
    void marmot
      .existingDirectConversation(publicKey)
      .then((conversation) => {
        if (!current) return;
        const state = lock.getState();
        if (
          !state.active ||
          state.locked ||
          privacy.isBlocked(publicKey) ||
          !chatsEnabled ||
          marmotSession.status() !== "ready" ||
          marmotSession.revision() !== sessionRevision
        ) {
          return;
        }
        setConversationRecord({
          peer: publicKey,
          revision: sessionRevision,
          privacyRevision,
          id: conversation,
        });
      })
      .catch(() => {
        if (current)
          setConversationRecord({
            peer: publicKey,
            revision: sessionRevision,
            privacyRevision,
            id: null,
          });
      });
    return () => {
      current = false;
    };
  }, [
    chatsEnabled,
    focused,
    lock,
    lockState.active,
    lockState.locked,
    privacy,
    privacyRevision,
    publicKey,
    restricted,
    sessionRevision,
    sessionStatus,
    marmotSession,
  ]);

  useFocusEffect(
    useCallback(() => {
      leaving.current = false;
      return () => {
        setAddressOpen(false);
        setContactEdit(undefined);
      };
    }, [setAddressOpen, setContactEdit]),
  );
  useEffect(
    () =>
      lock.subscribe(() => {
        const state = lock.getState();
        if (state.locked || !state.active) setContactEdit(undefined);
      }),
    [lock],
  );
  useEffect(
    () =>
      privacy.blocks.subscribe(() => {
        if (privacy.isBlocked(publicKey)) setContactEdit(undefined);
      }),
    [privacy, publicKey],
  );
  useEffect(() => {
    if (
      !focused ||
      !hint ||
      restricted ||
      lockState.locked ||
      !lockState.active
    )
      return;
    const parsed = parsePublicIdentity(hint);
    if (!parsed || parsed.key !== publicKey || !parsed.relays.length) return;
    const job = new AbortController();
    void profiles
      .refresh(publicKey, parsed.relays, job.signal)
      .catch(() => undefined);
    return () => job.abort();
  }, [
    restricted,
    focused,
    hint,
    lockState.active,
    lockState.locked,
    publicKey,
    profiles,
  ]);

  function write(action: () => void) {
    try {
      action();
      setNotice("");
      return true;
    } catch {
      setNotice(t("security:privacyWriteFailed"));
      return false;
    }
  }

  function saveProfileContact(edit: { kind: "add" | "rename"; name: string }) {
    if (!navigation.isFocused()) return;
    const state = lock.getState();
    if (!state.active || state.locked || privacy.isBlocked(publicKey)) return;

    try {
      const name = edit.name.trim();
      const saved = db.transaction((tx) => {
        const query = contactByKey(tx, publicKey);
        const previous = query.get();
        if (edit.kind === "add" && previous) return null;
        if (edit.kind === "add") {
          saveContact(tx, publicKey, name);
        } else {
          if (!previous) throw new Error("Contact was removed");
          updateContactPreferences(tx, publicKey, { name });
        }
        const row = query.get();
        if (!row) throw new Error("Missing saved contact");
        return row;
      });
      if (!saved) return;
      // Remove the tray in the same render that starts the profile's success effect.
      setContactEdit({
        kind: "saved",
        added: edit.kind === "add",
        commit: { row: saved, previous: observedContact },
      });
    } catch {
      if (edit.kind === "rename") setContactEditorError(true);
      else void dialog.show({ title: t("contacts:saveError"), tone: "error" });
      return;
    }
    Keyboard.dismiss();
    AccessibilityInfo.announceForAccessibility(t("common:saved"));
  }

  if (picking)
    return (
      <Screen>
        <AvatarPicker
          onCancel={() => setPicking(false)}
          onSave={(file) =>
            write(() => {
              avatars.saveOverride(publicKey, file.uri);
              setPicking(false);
            })
          }
        />
      </Screen>
    );

  const about = profile?.about;
  const website = profile?.website;
  const back = () => {
    if (leaving.current || !navigation.isFocused()) return;
    if (dismissProfile()) return;
    leaving.current = true;
    if (router.canGoBack()) router.back();
    else router.replace("/people");
  };
  const canManageProfile = focused && lockState.active && !lockState.locked;
  const canRequestImages =
    !restricted &&
    !avatars.autoLoads(publicKey) &&
    !imagesRequested &&
    Boolean(profile?.picture || profile?.banner);

  function openContactEditor() {
    if (!contact || !navigation.isFocused() || privacy.isBlocked(publicKey))
      return;
    setContactEditorError(false);
    setContactEdit({ kind: "rename", name: contact.name });
  }

  function confirmAddContact() {
    void dialog.show({
      title: t("contacts:confirmAdd", { name }),
      actions: [
        { label: t("common:cancel"), tone: "cancel" },
        {
          label: t("contacts:addToContacts"),
          tone: "primary",
          onSelect: () =>
            saveProfileContact({ kind: "add", name: profile?.name ?? "" }),
        },
      ],
    });
  }

  const menu: (ActionMenuProps["actions"][number] & {
    id: string;
    run: () => void;
  })[] = [];
  if (canManageProfile) {
    if (canRequestImages) {
      menu.push({
        id: "loadImages",
        icon: "download",
        image: "arrow.down.circle",
        title: t("messenger:loadImages"),
        run: () => avatars.requestProfileImages(publicKey),
      });
    }
    if (contact) {
      if (!restricted) {
        menu.push({
          id: "nickname",
          icon: "edit",
          image: "pencil",
          title: t("contacts:changeNickname"),
          run: openContactEditor,
        });
      }
      menu.push({
        id: "favorite",
        icon: "star",
        image: contact.favorite ? "star.slash" : "star",
        title: t(
          contact.favorite ? "contacts:removeFavorite" : "contacts:addFavorite",
        ),
        run: () =>
          write(() =>
            updateContactPreferences(db, publicKey, {
              favorite: !contact.favorite,
            }),
          ),
      });
      if (!restricted) {
        menu.push({
          id: "changePhoto",
          icon: "photo",
          image: "camera",
          title: t("settings:photoChange"),
          run: () => setPicking(true),
        });
        if (avatars.hasOverride(publicKey)) {
          menu.push({
            id: "removePhoto",
            icon: "trash",
            image: "trash",
            title: t("settings:photoRemove"),
            run: () => write(() => avatars.saveOverride(publicKey, null)),
          });
        }
      }
    }
    if (!block.disabled) {
      menu.push({
        id: "block",
        icon: block.blocked ? "check" : "warning",
        image: block.blocked ? "checkmark.shield" : "hand.raised",
        title: block.label,
        attributes: { destructive: !block.blocked },
        run: block.onPress,
      });
    }
    if (contact) {
      menu.push({
        id: "removeContact",
        icon: "trash",
        image: "person.crop.circle.badge.minus",
        title: t("messenger:removePerson"),
        attributes: { destructive: true },
        run: () =>
          void dialog.show({
            title: t("messenger:removePerson"),
            dismissible: false,
            actions: [
              { label: t("common:cancel"), tone: "cancel" },
              {
                label: t("messenger:removePerson"),
                tone: "danger",
                onSelect: () => write(() => removeContact(db, publicKey)),
              },
            ],
          }),
      });
    }
  }
  const tabs: ProfileTab<"media" | "groups">[] = [];
  if (hasMediaTab)
    tabs.push({ key: "media", label: t("messages:marmot.shortcutMedia") });
  tabs.push({ key: "groups", label: t("contacts:groupsTab") });
  const personHero = (active: boolean) => (
    <View style={styles.hero}>
      <View style={styles.identityLine}>
        <Transition.Boundary
          id={`avatar:${publicKey}`}
          enabled={active}
          accessibilityRole={canViewPhoto ? "button" : undefined}
          accessibilityLabel={
            canViewPhoto ? t("messenger:viewProfilePhoto") : undefined
          }
          {...(canViewPhoto
            ? {
                onPress: () =>
                  router.push({
                    pathname: "/profile-photo/[key]",
                    params: {
                      key: publicKey,
                      origin: `avatar:${publicKey}`,
                    },
                  }),
              }
            : {})}
          style={[styles.avatar, { backgroundColor: colors.background }]}
        >
          <ProfileElement profile={active ? morph : undefined} part="avatar">
            <PersonAvatar
              publicKey={publicKey}
              name={name}
              photo={photo}
              animateArrival={!morph}
              hasName={Boolean(contact?.name || profile?.name)}
              size="xxl"
            />
          </ProfileElement>
        </Transition.Boundary>
        <View style={styles.identity}>
          <ProfileElement profile={active ? morph : undefined} part="name">
            <Ink
              kind="profileName"
              accessibilityRole="header"
              numberOfLines={2}
              style={[
                styles.name,
                !contact?.name && !profile?.name && styles.fallbackName,
              ]}
            >
              {name}
            </Ink>
          </ProfileElement>
          {profile?.name && profile.name !== name && (
            <Ink muted kind="caption">
              {profile.name}
            </Ink>
          )}
          {profile?.handle && profile.handle !== profile.name && (
            <Ink muted kind="caption">
              @{profile.handle}
            </Ink>
          )}
          {profile?.nip05 && (
            <View
              style={styles.badge}
              accessible
              accessibilityLabel={`${t(verified ? "messenger:verified" : "messenger:unverified")}: ${profile.nip05}`}
            >
              {verified && <Icon name="check" size={14} />}
              <Ink muted={!verified} kind="caption">
                {profile.nip05}
              </Ink>
            </View>
          )}
        </View>
      </View>
      {profile?.bot && (
        <Ink kind="caption" muted>
          {t("messenger:bot")}
        </Ink>
      )}
    </View>
  );
  const profileActions = (
    <View style={styles.actions}>
      <CompactAction
        icon="qr"
        iconOnly
        label={t("security:showIdentityQr")}
        onPress={() => setAddressOpen(true)}
      />
      {chatsEnabled && (
        <CompactAction
          prominent
          style={styles.primary}
          icon="chat"
          label={t("contacts:message")}
          disabled={restricted}
          onPress={() =>
            router.push({
              pathname: "/chat/[key]",
              params: { key: publicKey },
            })
          }
        />
      )}
      <CompactAction
        iconOnly
        icon="phone"
        label={t("messenger:voice")}
        disabled={restricted}
        onPress={() =>
          router.push({
            pathname: "/call/[key]",
            params: { key: publicKey },
          })
        }
      />
    </View>
  );
  const profileTabs = (
    <ProfileTabs
      tabs={tabs}
      value={selectedTab}
      onChange={(tab) => {
        if (tab === "media") setVisitedMedia(true);
        setSelectedTab(tab);
      }}
    />
  );
  function renderOverview(motion: typeof profileMotion, active: boolean) {
    return (
      <View>
        <View
          style={[
            styles.banner,
            {
              height: bannerHeight,
              backgroundColor: colors.selected,
            },
          ]}
        >
          <Animated.View
            pointerEvents="none"
            style={[styles.bannerArtwork, motion.artwork]}
          >
            <ProfileBannerArtwork source={banner} />
          </Animated.View>
          {!sharedBack && (
            <GlassBackButton
              style={styles.bannerBack}
              elevation={morph ? "none" : undefined}
              dimOnPress={!morph}
              onPress={back}
            />
          )}
          {menu.length > 0 && (
            <ActionMenu
              style={styles.bannerEnd}
              label={t("contacts:profileOptions")}
              actions={menu.map(({ run, ...action }) => action)}
              onSelect={(id) => {
                const state = lock.getState();
                if (!navigation.isFocused() || !state.active || state.locked)
                  return;
                menu.find((action) => action.id === id)?.run();
              }}
            >
              <View style={styles.profileMenu}>
                <Icon
                  name="more"
                  size={22}
                  weight="bold"
                  color={colors.accent}
                />
              </View>
            </ActionMenu>
          )}
        </View>
        <Animated.View
          style={[styles.overview, { marginTop: -bannerOverlap }, motion.body]}
        >
          <View
            pointerEvents="none"
            style={[
              styles.overviewBackground,
              { top: bannerOverlap, backgroundColor: colors.background },
            ]}
          />
          {personHero(active)}
          {profileActions}
          {(about || website) && (
            <View style={styles.details}>
              {about && <Ink selectable>{about}</Ink>}
              {website && (
                <View style={styles.link}>
                  <Icon name="language" size={16} />
                  <Ink
                    kind="label"
                    numberOfLines={1}
                    style={[styles.primary, { color: colors.accent }]}
                    accessibilityRole="link"
                    onPress={() => {
                      void Linking.openURL(website).catch(() =>
                        setNotice(t("contacts:unavailable")),
                      );
                    }}
                  >
                    {new URL(website).hostname}
                  </Ink>
                </View>
              )}
            </View>
          )}
          {active && !restricted && <PersonCallHistory publicKey={publicKey} />}
          {!contact && !restricted && canManageProfile && (
            <Action
              onPress={confirmAddContact}
              variant="soft"
              style={styles.addContact}
            >
              <Icon name="addPerson" size={20} color={colors.accent} />
              {t("contacts:addToContacts")}
            </Action>
          )}
        </Animated.View>
        {notice && (
          <Ink style={styles.notice} accessibilityLiveRegion="polite">
            {notice}
          </Ink>
        )}
      </View>
    );
  }
  const profilePage = (
    <Animated.ScrollView
      style={styles.pages}
      stickyHeaderIndices={[1]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      onScroll={profileMotion.onScroll}
      scrollEventThrottle={16}
      alwaysBounceVertical={false}
      bounces={!profileMotion.reduceMotion}
      overScrollMode={profileMotion.reduceMotion ? "auto" : "never"}
    >
      {renderOverview(profileMotion, !showingLibrary)}
      <Animated.View style={profileMotion.body}>{profileTabs}</Animated.View>
      <Animated.View style={[styles.body, profileMotion.body]}>
        {showingMedia ? (
          mediaConversation === undefined ? (
            <ActivityIndicator />
          ) : (
            <QuietState icon="media" title={t("messages:sharedMedia.empty")} />
          )
        ) : showingGroups ? (
          chatsEnabled &&
          !restricted &&
          canManageProfile && <PersonGroups publicKey={publicKey} />
        ) : null}
        {showingGroups && (!chatsEnabled || restricted) && (
          <QuietState icon="people" title={t("common:unavailable")} />
        )}
      </Animated.View>
    </Animated.ScrollView>
  );

  return (
    <Screen scroll={false} topInset>
      <View style={styles.pages}>
        <View
          pointerEvents={showingLibrary ? "none" : "auto"}
          accessibilityElementsHidden={showingLibrary}
          importantForAccessibility={
            showingLibrary ? "no-hide-descendants" : "auto"
          }
          style={[styles.profileLayer, showingLibrary && styles.hiddenLayer]}
        >
          {profileMotion.android && !profileMotion.reduceMotion ? (
            <GestureDetector gesture={profileMotion.androidGesture}>
              {profilePage}
            </GestureDetector>
          ) : (
            profilePage
          )}
        </View>
        {visitedMedia && mediaAvailable && mediaConversation && (
          <View
            pointerEvents={showingLibrary ? "auto" : "none"}
            accessibilityElementsHidden={!showingLibrary}
            importantForAccessibility={
              showingLibrary ? "auto" : "no-hide-descendants"
            }
            style={[styles.profileLayer, !showingLibrary && styles.hiddenLayer]}
          >
            <SharedMediaLibrary
              scope={{ kind: "direct", group: mediaConversation }}
              header={renderOverview(mediaMotion, showingLibrary)}
              tabs={profileTabs}
              onAnimatedScroll={mediaMotion.onScroll}
              scrollPositionRef={mediaScrollPosition}
              active={showingLibrary && focused}
            />
          </View>
        )}
      </View>
      {contactEdit?.kind !== "saved" && (
        <GlassSheet
          open={
            focused &&
            lockState.active &&
            !restricted &&
            !lockState.locked &&
            !!contactEditor
          }
          onOpenChange={(open) => {
            if (!open) setContactEdit(undefined);
          }}
        >
          <GlassSheetContent>
            {contactEditor && (
              <>
                <GlassSheetTitle>
                  {t("contacts:changeNickname")}
                </GlassSheetTitle>
                <GlassInput
                  label={t("contacts:nickname")}
                  value={contactEditor.name}
                  onChangeText={(name) => {
                    setContactEdit({ ...contactEditor, name });
                    setContactEditorError(false);
                  }}
                  maxLength={128}
                />
                {contactEditorError && (
                  <Ink
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                  >
                    {t("contacts:saveError")}
                  </Ink>
                )}
                <Action
                  size="lg"
                  onPress={() => saveProfileContact(contactEditor)}
                >
                  {t("common:save")}
                </Action>
              </>
            )}
          </GlassSheetContent>
        </GlassSheet>
      )}
      <GlassSheet open={focused && addressOpen} onOpenChange={setAddressOpen}>
        <GlassSheetContent>
          <AddressSheetContent address={address} showQr hideAddress />
        </GlassSheetContent>
      </GlassSheet>
      {focused &&
        !reduceMotion &&
        !reduceTransparency &&
        contactEdit?.kind === "saved" &&
        contactEdit.added && <AuraLift scope="profile" />}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  hero: { gap: theme.space.md },
  body: {
    gap: theme.space.lg,
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.md,
    paddingBottom: theme.space.xxl,
  },
  profileLayer: { ...StyleSheet.absoluteFill },
  hiddenLayer: { opacity: 0 },
  pages: { flex: 1 },
  overview: {
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingBottom: theme.space.md,
  },
  banner: { position: "relative" },
  bannerArtwork: {
    ...StyleSheet.absoluteFill,
    overflow: "hidden",
    transformOrigin: "center top",
  },
  overviewBackground: { ...StyleSheet.absoluteFill },
  bannerBack: {
    position: "absolute",
    zIndex: 2,
    start: theme.space.sm,
    top: theme.space.sm,
  },
  bannerEnd: {
    position: "absolute",
    top: theme.space.sm,
    end: theme.space.sm,
  },
  profileMenu: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.raised,
    borderRadius: theme.radius.round,
  },
  addContact: { alignSelf: "center" },
  identityLine: {
    alignItems: "center",
    gap: theme.space.sm,
    paddingHorizontal: theme.space.sm,
  },
  avatar: { padding: 4, borderRadius: theme.radius.round },
  identity: {
    maxWidth: "100%",
    alignItems: "center",
    gap: theme.space.xs,
    paddingBottom: theme.space.sm,
  },
  name: { ...theme.type.profileName, textAlign: "center" },
  fallbackName: { ...theme.type.heading, fontSize: 18, letterSpacing: 0 },
  badge: { flexDirection: "row", alignItems: "center", gap: theme.space.xs },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: theme.space.sm,
  },
  primary: { flex: 1 },
  details: {
    gap: theme.space.sm,
  },
  notice: { marginHorizontal: theme.space.lg },
  link: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.sm,
    minHeight: 44,
  },
}));
