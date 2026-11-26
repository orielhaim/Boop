import { ScreenHeader } from "@/components/navigation/screen-header";
import Transition from "react-native-screen-transitions";
import { useMinimizeOnScroll } from "@/components/navigation/dock-motion";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
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
import Animated, { useComposedEventHandler } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { AvatarPicker } from "@/components/avatars/picker";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { GlassInput } from "@/components/glassyui/glass-input";
import { ProfileElement } from "@/components/navigation/profile-elements";
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
import { useTheme } from "@/theme";
import { AddressSheetContent } from "./address-sheet";
import { useIdentitySheet } from "./identity-sheet";
import { PersonCallHistory, PersonGroups } from "./person-context";
import { PersonAvatar } from "./person-avatar";
import { usePersonIdentity, useVerifiedIdentifier } from "./use-person";

export function PersonProfile({
  publicKey,
  hint,
  morph,
  tab = false,
}: {
  publicKey: string | null;
  hint?: string;
  morph?: string;
  tab?: boolean;
}) {
  const { t } = useTranslation(namespaces);
  return publicKey ? (
    <ProfileContent
      key={publicKey}
      publicKey={publicKey}
      hint={hint}
      morph={morph}
      tab={tab}
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
  tab,
}: {
  publicKey: string;
  hint?: string;
  morph?: string;
  tab: boolean;
}) {
  const onScroll = useMinimizeOnScroll();
  const { height } = useWindowDimensions();
  const bannerHeight = Math.max(1, Math.min(148, height * 0.2));
  const profileMotion = useAnimateScrollView(bannerHeight);
  const mediaMotion = useAnimateScrollView(bannerHeight);
  const profileScroll = useComposedEventHandler([
    profileMotion.onScroll,
    tab ? onScroll : null,
  ]);
  const { t } = useTranslation(namespaces);
  const dialog = useDialog();
  const {
    avatars,
    db,
    identity,
    initialProfile,
    lock,
    marmotSession,
    privacy,
    profileEditor,
    profiles,
  } = useLocal();
  const { colors, reduceMotion, reduceTransparency } = useTheme();
  const focused = useIsFocused();
  const navigation = useNavigation();
  const leaving = useRef(false);
  const lockState = useSyncExternalStore(lock.subscribe, lock.getState);
  const privacyRevision = useSyncExternalStore(
    privacy.subscribe,
    privacy.revision,
  );
  const { draft, photoPreview, bannerPreview } = useSyncExternalStore(
    profileEditor.subscribe,
    profileEditor.getSnapshot,
  );
  const {
    contact: observedContact,
    profile,
    name: observedName,
  } = usePersonIdentity(publicKey);
  const publicPhoto = useAvatar(publicKey, true, false, true);
  const own = identity.publicKey === publicKey;
  const pendingProfile = own ? draft : undefined;
  const photo =
    pendingProfile?.photo.kind === "remove"
      ? undefined
      : own
        ? (photoPreview ?? publicPhoto)
        : publicPhoto;
  const canViewPhoto = Boolean(photo);
  const localName = pendingProfile?.name;
  const publicBanner = useAvatar(publicKey, true, true, true);
  const banner =
    pendingProfile?.banner?.kind === "remove"
      ? undefined
      : own
        ? (bannerPreview ?? publicBanner)
        : publicBanner;
  const details = {
    ...profile,
    website: pendingProfile?.website ?? profile?.website,
    nip05: pendingProfile?.nip05 ?? profile?.nip05,
  };
  const block = useBlockAction(publicKey);
  const restricted = privacy.isBlocked(publicKey);
  const verified = useVerifiedIdentifier(
    focused && !restricted ? details.nip05 : undefined,
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
  const showIdentitySheet = useIdentitySheet();
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
  const [tabChoice, setSelectedTab] = useState<
    "profile" | "media" | "groups"
  >();
  const mediaScrollPosition = useRef(0);
  const mediaConversation =
    conversationRecord?.peer === publicKey &&
    conversationRecord.revision === sessionRevision &&
    conversationRecord.privacyRevision === privacyRevision &&
    !own &&
    !restricted
      ? conversationRecord.id
      : undefined;
  const mediaAvailable =
    typeof mediaConversation === "string" &&
    chatsEnabled &&
    lockState.active &&
    !lockState.locked &&
    sessionStatus === "ready";
  const hasMediaTab = chatsEnabled && !own && !restricted;
  const selectedTab = own
    ? tabChoice === "groups"
      ? "groups"
      : "profile"
    : hasMediaTab && tabChoice === "media"
      ? "media"
      : "groups";
  const showingMedia = selectedTab === "media";
  const showingGroups = selectedTab === "groups";
  const showingLibrary = showingMedia && mediaAvailable;

  useEffect(() => {
    let current = true;
    if (own || restricted) return;
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
    own,
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
    if (own || !navigation.isFocused()) return;
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

  const about =
    pendingProfile?.about ??
    (profile ? details.about : own ? initialProfile.about : undefined);
  const displayName = localName || name;
  const editProfile = () => router.push("/settings/edit-profile");
  const back = () => {
    if (leaving.current || !navigation.isFocused()) return;
    leaving.current = true;
    if (router.canGoBack()) router.back();
    else router.replace("/people");
  };
  const showQr = () => {
    if (own) {
      showIdentitySheet("qr");
      return;
    }
    setAddressOpen(true);
  };
  const canManageProfile = focused && lockState.active && !lockState.locked;
  const canRequestImages =
    !restricted &&
    !avatars.autoLoads(publicKey) &&
    !imagesRequested &&
    Boolean(profile?.picture || details.banner);

  function openContactEditor() {
    if (!contact || !navigation.isFocused() || privacy.isBlocked(publicKey))
      return;
    setContactEditorError(false);
    setContactEdit({ kind: "rename", name: contact.name });
  }

  function confirmAddContact() {
    void dialog.show({
      title: t("contacts:confirmAdd", { name: displayName }),
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
  if (!own && canManageProfile) {
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
  const tabs: ProfileTab<"profile" | "media" | "groups">[] = [];
  if (own) tabs.push({ key: "profile", label: t("messages:sharedMedia.info") });
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
              name={displayName}
              photo={photo}
              animateArrival={!morph}
              hasName={Boolean(localName || contact?.name || profile?.name)}
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
                !localName &&
                  !contact?.name &&
                  !profile?.name &&
                  styles.fallbackName,
              ]}
            >
              {displayName}
            </Ink>
          </ProfileElement>
          {profile?.name && profile.name !== name && (
            <Ink muted kind="caption">
              {profile.name}
            </Ink>
          )}
          {details.handle && details.handle !== profile?.name && (
            <Ink muted kind="caption">
              @{details.handle}
            </Ink>
          )}
          {details.nip05 && (
            <View
              style={styles.badge}
              accessible
              accessibilityLabel={`${t(verified ? "messenger:verified" : "messenger:unverified")}: ${details.nip05}`}
            >
              {verified && <Icon name="check" size={14} />}
              <Ink muted={!verified} kind="caption">
                {details.nip05}
              </Ink>
            </View>
          )}
        </View>
      </View>
      {details.bot && (
        <Ink kind="caption" muted>
          {t("messenger:bot")}
        </Ink>
      )}
    </View>
  );
  const profileActions = own ? (
    <View style={styles.actions}>
      <CompactAction
        icon="edit"
        label={t("settings:editProfile")}
        onPress={editProfile}
      />
      {tab && (
        <CompactAction
          icon="settings"
          label={t("navigation:settings")}
          onPress={() => router.push("/settings")}
        />
      )}
    </View>
  ) : (
    <View style={styles.actions}>
      <CompactAction
        icon="qr"
        iconOnly
        label={t("security:showIdentityQr")}
        onPress={showQr}
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
    <ProfileTabs tabs={tabs} value={selectedTab} onChange={setSelectedTab} />
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
            {!reduceTransparency && (
              <LinearGradient
                colors={[colors.heroStart, colors.selected, colors.heroEnd]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
            )}
            {banner ? (
              <Image
                source={banner}
                contentFit="cover"
                style={StyleSheet.absoluteFill}
              />
            ) : (
              <View
                pointerEvents="none"
                style={[styles.orbit, { borderColor: colors.line }]}
              />
            )}
          </Animated.View>
          {!tab && (
            <GlassBackButton
              style={styles.bannerBack}
              elevation={morph ? "none" : undefined}
              dimOnPress={!morph}
              onPress={back}
            />
          )}
          {own ? (
            <CompactAction
              icon="qr"
              iconOnly
              style={styles.bannerEnd}
              label={t("security:showIdentityQr")}
              onPress={showQr}
            />
          ) : menu.length > 0 ? (
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
          ) : null}
        </View>
        <Animated.View style={[styles.overview, motion.body]}>
          <View
            pointerEvents="none"
            style={[
              styles.overviewBackground,
              { backgroundColor: colors.background },
            ]}
          />
          {personHero(active)}
          {profileActions}
          {(about || details.website) && (
            <View style={styles.details}>
              {about && <Ink selectable>{about}</Ink>}
              {details.website && (
                <View style={styles.link}>
                  <Icon name="language" size={16} />
                  <Ink
                    kind="label"
                    numberOfLines={1}
                    style={[styles.primary, { color: colors.accent }]}
                    accessibilityRole="link"
                    onPress={() => {
                      if (details.website)
                        void Linking.openURL(details.website).catch(() =>
                          setNotice(t("contacts:unavailable")),
                        );
                    }}
                  >
                    {new URL(details.website).hostname}
                  </Ink>
                </View>
              )}
            </View>
          )}
          {active && !own && !restricted && (
            <PersonCallHistory publicKey={publicKey} />
          )}
          {!own && !contact && !restricted && canManageProfile && (
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
      onScroll={profileScroll}
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
    <Screen scroll={false} tab={tab} topInset>
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
        {mediaAvailable && mediaConversation && (
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
      {!own && contactEdit?.kind !== "saved" && (
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
      {!own && (
        <GlassSheet open={focused && addressOpen} onOpenChange={setAddressOpen}>
          <GlassSheetContent>
            <AddressSheetContent address={address} showQr hideAddress />
          </GlassSheetContent>
        </GlassSheet>
      )}
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
    marginTop: -54,
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
  overviewBackground: { ...StyleSheet.absoluteFill, top: 54 },
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
  orbit: {
    position: "absolute",
    width: 280,
    height: 280,
    borderRadius: 140,
    borderWidth: 1,
    end: -28,
    top: -160,
  },
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
