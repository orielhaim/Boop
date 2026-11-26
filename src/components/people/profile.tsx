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
import { Keyboard, Linking, useWindowDimensions, View } from "react-native";
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
import { SharedMediaLibrary } from "@/components/shared-media/library";
import {
  ProfileTabs,
  type ProfileTab,
} from "@/components/shared-media/profile-tabs";
import { ListGroup, ListRow } from "@/components/ui/list-group";
import { useDialog } from "@/components/ui/dialog";
import {
  ChatProfileBackButton,
  GlassBackButton,
} from "@/components/ui/back-button";
import { Empty, Icon, Ink, Screen } from "@/components/ui/kit";
import { CompactAction } from "@/components/ui/messenger-ui";
import { useBlockAction } from "@/components/ui/privacy-actions";
import { SaveButton } from "@/components/ui/save-button";
import { AuraLift } from "@/components/ui/organisms/aura-lift";
import { useAvatar } from "@/core/avatars/use-avatar";
import { parsePublicIdentity, toNpub } from "@/core/identity/keys";
import { marmot } from "@/core/marmot/native";
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
import { PersonContext } from "./person-context";
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
  const { colors, reduceTransparency } = useTheme();
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
  const { contact, profile, name } = usePersonIdentity(publicKey);
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
  const [contactEditor, setContactEditor] = useState<{
    kind: "add" | "rename";
    name: string;
  }>();
  const [contactEditorError, setContactEditorError] = useState(false);
  const [contactAdded, setContactAdded] = useState(false);
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
  const [selectedTab, setSelectedTab] = useState<"profile" | "media">(
    "profile",
  );
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
  const showingMedia = mediaAvailable && selectedTab === "media";

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

  if (mediaConversation === null && selectedTab === "media")
    setSelectedTab("profile");

  useFocusEffect(
    useCallback(() => {
      leaving.current = false;
      return () => {
        setAddressOpen(false);
        setContactEditor(undefined);
      };
    }, [setAddressOpen, setContactEditor]),
  );
  useEffect(
    () =>
      lock.subscribe(() => {
        const state = lock.getState();
        if (state.locked || !state.active) setContactEditor(undefined);
      }),
    [lock],
  );
  useEffect(
    () =>
      privacy.blocks.subscribe(() => {
        if (privacy.isBlocked(publicKey)) setContactEditor(undefined);
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
  const tabs: ProfileTab<"profile" | "media">[] = mediaAvailable
    ? [
        { key: "profile", label: t("messages:sharedMedia.info") },
        { key: "media", label: t("messages:marmot.shortcutMedia") },
      ]
    : [];
  const profileTabs = mediaAvailable ? (
    <ProfileTabs tabs={tabs} value={selectedTab} onChange={setSelectedTab} />
  ) : undefined;
  const personHero = (
    <View style={styles.hero}>
      <View style={styles.identityLine}>
        <Transition.Boundary
          id={`avatar:${publicKey}`}
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
          <ProfileElement profile={morph} part="avatar">
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
          <ProfileElement profile={morph} part="name">
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
  return (
    <Screen scroll={false} tab={tab} topInset>
      <View
        style={[
          styles.banner,
          {
            height: Math.min(148, height * 0.2),
            backgroundColor: colors.selected,
          },
        ]}
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
        {!tab && !morph && (
          <GlassBackButton style={styles.bannerBack} onPress={back} />
        )}
        <CompactAction
          icon="qr"
          iconOnly
          style={styles.bannerQr}
          label={t("security:showIdentityQr")}
          onPress={showQr}
        />
      </View>
      <View style={styles.overview}>
        {personHero}
        {profileActions}
      </View>
      {profileTabs}
      <View style={styles.pages}>
        <View
          pointerEvents={showingMedia ? "none" : "auto"}
          accessibilityElementsHidden={showingMedia}
          importantForAccessibility={
            showingMedia ? "no-hide-descendants" : "auto"
          }
          style={[
            StyleSheet.absoluteFill,
            styles.profileLayer,
            showingMedia && styles.hiddenLayer,
          ]}
        >
          <Animated.ScrollView
            style={styles.pages}
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            onScroll={tab ? onScroll : undefined}
            scrollEventThrottle={16}
          >
            {(about || details.website) && (
              <View style={[styles.details, { borderColor: colors.line }]}>
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
            {!restricted &&
              !avatars.autoLoads(publicKey) &&
              !imagesRequested &&
              Boolean(profile?.picture || details.banner) && (
                <CompactAction
                  icon="download"
                  label={t("messenger:loadImages")}
                  onPress={() => avatars.requestProfileImages(publicKey)}
                />
              )}
            {!own && (
              <GlassSheet
                open={
                  focused &&
                  lockState.active &&
                  !restricted &&
                  !lockState.locked &&
                  !!contactEditor
                }
                onOpenChange={(open) => {
                  if (!open) setContactEditor(undefined);
                }}
              >
                <GlassSheetContent>
                  {contactEditor && (
                    <>
                      <GlassSheetTitle>
                        {t(
                          contactEditor.kind === "add"
                            ? "contacts:saveAs"
                            : "messenger:nickname",
                        )}
                      </GlassSheetTitle>
                      <GlassInput
                        label={t("contacts:nickname")}
                        value={contactEditor.name}
                        onChangeText={(name) => {
                          setContactEditor({ ...contactEditor, name });
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
                      <SaveButton
                        label={t("contacts:save")}
                        savedDecoration={
                          contactAdded ? <AuraLift /> : undefined
                        }
                        onSave={() => {
                          try {
                            const state = lock.getState();
                            if (
                              !state.active ||
                              state.locked ||
                              privacy.isBlocked(publicKey)
                            ) {
                              setContactEditorError(true);
                              return false;
                            }
                            const name = contactEditor.name.trim();
                            const added = db.transaction((tx) => {
                              if (contactByKey(tx, publicKey).get()) {
                                updateContactPreferences(tx, publicKey, {
                                  name,
                                });
                                return false;
                              }
                              saveContact(tx, publicKey, name);
                              return true;
                            });
                            setContactAdded(added);
                            Keyboard.dismiss();
                            return true;
                          } catch {
                            setContactEditorError(true);
                            return false;
                          }
                        }}
                        onSaved={() => setContactEditor(undefined)}
                      />
                    </>
                  )}
                </GlassSheetContent>
              </GlassSheet>
            )}
            {!own && (
              <ListGroup>
                {!restricted && (
                  <ListRow
                    title={t(
                      contact ? "messenger:nickname" : "contacts:saveAs",
                    )}
                    detail={contact?.name || undefined}
                    onPress={() => {
                      setContactEditorError(false);
                      setContactEditor({
                        kind: contact ? "rename" : "add",
                        name: contact ? contact.name : (profile?.name ?? ""),
                      });
                    }}
                  />
                )}
                {contact && (
                  <>
                    <ListRow
                      title={t(
                        contact.favorite
                          ? "contacts:removeFavorite"
                          : "contacts:addFavorite",
                      )}
                      onPress={() =>
                        write(() =>
                          updateContactPreferences(db, publicKey, {
                            favorite: !contact.favorite,
                          }),
                        )
                      }
                    />
                    {!restricted && (
                      <>
                        <ListRow
                          title={t("settings:photoChange")}
                          detail={t("settings:photoLocalHelp")}
                          onPress={() => setPicking(true)}
                        />
                        {avatars.hasOverride(publicKey) && (
                          <ListRow
                            title={t("settings:photoRemove")}
                            onPress={() =>
                              write(() => avatars.saveOverride(publicKey, null))
                            }
                          />
                        )}
                        <ListRow
                          title={t("video:automatic")}
                          detail={contact.allowIncomingVideo ? "✓" : undefined}
                          onPress={() =>
                            write(() =>
                              updateContactPreferences(db, publicKey, {
                                allowIncomingVideo: !contact.allowIncomingVideo,
                              }),
                            )
                          }
                        />
                      </>
                    )}
                    <ListRow
                      title={t("messenger:removePerson")}
                      onPress={() =>
                        void dialog.show({
                          title: t("messenger:removePerson"),
                          dismissible: false,
                          actions: [
                            { label: t("common:cancel"), tone: "cancel" },
                            {
                              label: t("messenger:removePerson"),
                              tone: "danger",
                              onSelect: () =>
                                write(() => removeContact(db, publicKey)),
                            },
                          ],
                        })
                      }
                    />
                  </>
                )}
                <ListRow
                  title={block.label}
                  onPress={block.disabled ? undefined : block.onPress}
                />
              </ListGroup>
            )}
            {!own && !restricted && <PersonContext publicKey={publicKey} />}
            {notice && <Ink accessibilityLiveRegion="polite">{notice}</Ink>}
          </Animated.ScrollView>
        </View>
        {mediaConversation && (
          <View
            pointerEvents={showingMedia ? "auto" : "none"}
            accessibilityElementsHidden={!showingMedia}
            importantForAccessibility={
              showingMedia ? "auto" : "no-hide-descendants"
            }
            style={[
              StyleSheet.absoluteFill,
              styles.profileLayer,
              !showingMedia && styles.hiddenLayer,
            ]}
          >
            <SharedMediaLibrary
              scope={{ kind: "direct", group: mediaConversation }}
              scrollPositionRef={mediaScrollPosition}
              active={showingMedia}
            />
          </View>
        )}
      </View>
      {!own && (
        <GlassSheet open={focused && addressOpen} onOpenChange={setAddressOpen}>
          <GlassSheetContent>
            <AddressSheetContent address={address} showQr hideAddress />
          </GlassSheetContent>
        </GlassSheet>
      )}
      {morph && <ChatProfileBackButton onPress={back} />}
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
  profileLayer: { flex: 1, zIndex: 1 },
  hiddenLayer: { opacity: 0, zIndex: 0 },
  pages: { flex: 1 },
  overview: {
    marginTop: -54,
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingBottom: theme.space.md,
  },
  banner: {
    overflow: "hidden",
  },
  bannerBack: {
    position: "absolute",
    start: theme.space.sm,
    top: theme.space.sm,
  },
  bannerQr: {
    position: "absolute",
    top: theme.space.sm,
    end: theme.space.sm,
  },
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
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: theme.space.md,
    gap: theme.space.sm,
  },
  link: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.sm,
    minHeight: 44,
  },
}));
