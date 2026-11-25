import { ScreenHeader } from "@/components/navigation/screen-header";
import Transition from "react-native-screen-transitions";
import { useMinimizeOnScroll } from "expo-glass-tabs";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, Linking, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AvatarPicker } from "@/components/avatars/picker";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { GlassInput } from "@/components/glassyui/glass-input";
import { ProfileElement } from "@/components/navigation/profile-elements";
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
import { ParallaxScrollView } from "@/components/ui/templates/parallax-header/components/AnimatedScrollView";
import { useAvatar } from "@/core/avatars/use-avatar";
import { parsePublicIdentity, toNpub } from "@/core/identity/keys";
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
import { usePerson, useVerifiedIdentifier } from "./use-person";

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
  const { t } = useTranslation(namespaces);
  const dialog = useDialog();
  const {
    avatars,
    db,
    identity,
    initialProfile,
    lock,
    privacy,
    profileEditor,
    profiles,
  } = useLocal();
  const { colors, reduceTransparency } = useTheme();
  const focused = useIsFocused();
  const lockState = useSyncExternalStore(lock.subscribe, lock.getState);
  const privacyRevision = useSyncExternalStore(
    privacy.subscribe,
    privacy.revision,
  );
  const { draft, photoPreview, bannerPreview } = useSyncExternalStore(
    profileEditor.subscribe,
    profileEditor.getSnapshot,
  );
  const { contact, profile, photo: publicPhoto, name } = usePerson(publicKey);
  const own = identity.publicKey === publicKey;
  const pendingProfile = own ? draft : undefined;
  const photo =
    pendingProfile?.photo.kind === "remove"
      ? undefined
      : own
        ? (photoPreview ?? publicPhoto)
        : publicPhoto;
  const canViewPhoto =
    !!photo &&
    (own || avatars.autoLoads(publicKey) || avatars.hasOverride(publicKey));
  const localName = pendingProfile?.name;
  const publicBanner = useAvatar(publicKey, true, true);
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
  const address = toNpub(publicKey);
  const showIdentitySheet = useIdentitySheet();
  const [qr, setQr] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const [contactEditor, setContactEditor] = useState<{
    kind: "add" | "rename";
    name: string;
  }>();
  const [contactEditorError, setContactEditorError] = useState(false);
  const [contactAdded, setContactAdded] = useState(false);
  const [picking, setPicking] = useState(false);
  const [imageConsent, setImageConsent] = useState<number>();
  const allowImages = imageConsent === privacyRevision;
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (
      focused &&
      lockState.active &&
      !lockState.locked &&
      !restricted &&
      allowImages
    )
      return avatars.allowVisit(publicKey);
  }, [
    allowImages,
    avatars,
    restricted,
    focused,
    lockState.active,
    lockState.locked,
    publicKey,
  ]);
  useFocusEffect(
    useCallback(
      () => () => {
        setImageConsent(undefined);
        setContactEditor(undefined);
      },
      [setImageConsent, setContactEditor],
    ),
  );
  useEffect(
    () =>
      lock.subscribe(() => {
        const state = lock.getState();
        if (state.locked || !state.active) {
          setImageConsent(undefined);
          setContactEditor(undefined);
        }
      }),
    [lock],
  );
  useEffect(
    () =>
      privacy.blocks.subscribe(() => {
        if (privacy.isBlocked(publicKey)) {
          setImageConsent(undefined);
          setContactEditor(undefined);
        }
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
  const shortAddress = `${address.slice(0, 15)}…${address.slice(-6)}`;
  const editProfile = () => router.push("/settings/edit-profile");
  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/people");
  };
  return (
    <Screen scroll={false} tab={tab} topInset>
      {morph && <ChatProfileBackButton onPress={back} />}
      <ParallaxScrollView
        headerMaxHeight={148}
        headerOverlap={54}
        backgroundColor={colors.background}
        bodyStyle={styles.body}
        onScroll={tab ? onScroll : undefined}
        header={
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: colors.selected },
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
            {banner && (
              <Image
                source={banner}
                contentFit="cover"
                style={StyleSheet.absoluteFill}
              />
            )}
            {!banner && (
              <View
                pointerEvents="none"
                style={[styles.orbit, { borderColor: colors.line }]}
              />
            )}
          </View>
        }
        headerControls={
          <>
            {!tab && !morph && (
              <GlassBackButton style={styles.bannerBack} onPress={back} />
            )}
            <CompactAction
              icon="qr"
              iconOnly
              style={styles.bannerQr}
              label={t("security:showIdentityQr")}
              onPress={() => {
                if (own) {
                  showIdentitySheet("qr");
                  return;
                }
                setQr(true);
                setAddressOpen(true);
              }}
            />
          </>
        }
      >
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
        {own ? (
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
        )}
        {(about || details.website || !own) && (
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
            {!own && (
              <Ink
                kind="caption"
                accessibilityRole="button"
                accessibilityLabel={t("settings:publicAddress")}
                style={[styles.addressTrigger, { color: colors.accent }]}
                onPress={() => {
                  setQr(false);
                  setAddressOpen(true);
                }}
              >
                {shortAddress}
              </Ink>
            )}
          </View>
        )}
        {!restricted &&
          !avatars.autoLoads(publicKey) &&
          !allowImages &&
          Boolean(profile?.picture || details.banner) && (
            <CompactAction
              icon="download"
              label={t("messenger:loadImages")}
              onPress={() => setImageConsent(privacyRevision)}
            />
          )}
        {!own && (
          <GlassSheet open={addressOpen} onOpenChange={setAddressOpen}>
            <GlassSheetContent>
              <AddressSheetContent
                address={address}
                showQr={qr}
                onShowQr={() => setQr(true)}
              />
            </GlassSheetContent>
          </GlassSheet>
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
                    savedDecoration={contactAdded ? <AuraLift /> : undefined}
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
                            updateContactPreferences(tx, publicKey, { name });
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
                title={t(contact ? "messenger:nickname" : "contacts:saveAs")}
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
      </ParallaxScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  hero: { gap: theme.space.md },
  body: {
    gap: theme.space.lg,
    paddingHorizontal: theme.space.lg,
    paddingBottom: theme.space.xxl,
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
  addressTrigger: {
    minHeight: 44,
    textAlignVertical: "center",
    writingDirection: "ltr",
  },
}));
