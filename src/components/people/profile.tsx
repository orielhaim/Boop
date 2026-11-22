import { useMinimizeOnScroll } from "expo-glass-tabs";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Linking, StyleSheet, View } from "react-native";
import { AvatarPicker } from "@/components/avatars/picker";
import {
  GlassSheet,
  GlassSheetContent,
} from "@/components/glassyui/glass-sheet";
import { GlassInput } from "@/components/glassyui/glass-input";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { GlassBackButton } from "@/components/ui/back-button";
import { Action, Empty, Icon, Ink, Screen } from "@/components/ui/kit";
import { CompactAction } from "@/components/ui/messenger-ui";
import { useBlockAction } from "@/components/ui/privacy-actions";
import { profileDetails } from "@/core/avatars/protocol";
import { useAvatar } from "@/core/avatars/use-avatar";
import { parsePublicIdentity, toNpub } from "@/core/identity/keys";
import {
  contactByKey,
  saveContact,
  updateContactPreferences,
} from "@/db/queries";
import { contacts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";
import { radius, space, useTheme } from "@/theme";
import { AddressSheetContent } from "./address-sheet";
import { useIdentitySheet } from "./identity-sheet";
import { PersonContext } from "./person-context";
import { PersonAvatar } from "./person-avatar";
import { usePerson, useVerifiedIdentifier } from "./use-person";

export function PersonProfile({
  publicKey,
  hint,
  tab = false,
}: {
  publicKey: string | null;
  hint?: string;
  tab?: boolean;
}) {
  const { t } = useTranslation(namespaces);
  return publicKey ? (
    <ProfileContent
      key={publicKey}
      publicKey={publicKey}
      hint={hint}
      tab={tab}
    />
  ) : (
    <Screen>
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
  tab,
}: {
  publicKey: string;
  hint?: string;
  tab: boolean;
}) {
  const onScroll = useMinimizeOnScroll();
  const { t } = useTranslation(namespaces);
  const {
    avatars,
    db,
    identity,
    lock,
    privacy,
    profileEditor,
    publicMetadata,
  } = useLocal();
  const { colors, reduceTransparency } = useTheme();
  const focused = useIsFocused();
  const lockState = useSyncExternalStore(lock.subscribe, lock.getState);
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const { draft, stage } = useSyncExternalStore(
    profileEditor.subscribe,
    profileEditor.getSnapshot,
  );
  const { contact, profile, photo, name } = usePerson(publicKey);
  const own = identity.publicKey === publicKey;
  const pendingProfile = own ? draft : undefined;
  const localName = !profile?.name ? pendingProfile?.name : undefined;
  const banner = useAvatar(publicKey, true, true);
  const details = profileDetails(profile?.fields);
  const block = useBlockAction(publicKey);
  const verified = useVerifiedIdentifier(
    focused && !block.blocked ? details.nip05 : undefined,
    publicKey,
  );
  const chatsEnabled = useChatsEnabled();
  const address = toNpub(publicKey);
  const showIdentitySheet = useIdentitySheet();
  const [qr, setQr] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false);
  const [nickname, setNickname] = useState<string>();
  const [picking, setPicking] = useState(false);
  const [allowImages, setAllowImages] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (
      focused &&
      lockState.active &&
      !lockState.locked &&
      !block.blocked &&
      allowImages
    )
      return avatars.allowVisit(publicKey);
  }, [
    allowImages,
    avatars,
    block.blocked,
    focused,
    lockState.active,
    lockState.locked,
    publicKey,
  ]);
  useFocusEffect(
    useCallback(() => () => setAllowImages(false), [setAllowImages]),
  );
  useEffect(
    () =>
      lock.subscribe(() => {
        const state = lock.getState();
        if (state.locked || !state.active) setAllowImages(false);
      }),
    [lock],
  );
  useEffect(
    () =>
      privacy.subscribeBlock((key) => {
        if (key === publicKey) setAllowImages(false);
      }),
    [privacy, publicKey],
  );
  useEffect(() => {
    if (
      !focused ||
      !hint ||
      block.blocked ||
      lockState.locked ||
      !lockState.active
    )
      return;
    const parsed = parsePublicIdentity(hint);
    if (!parsed || parsed.key !== publicKey || !parsed.relays.length) return;
    const job = new AbortController();
    void publicMetadata
      .lookupProfileHints(publicKey, parsed.relays, avatars.ingest, job.signal)
      .catch(() => undefined);
    return () => job.abort();
  }, [
    avatars,
    block.blocked,
    focused,
    hint,
    lockState.active,
    lockState.locked,
    publicKey,
    publicMetadata,
  ]);

  function write(action: () => void) {
    try {
      action();
      setNotice("");
    } catch {
      setNotice(t("security:privacyWriteFailed"));
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

  const about = details.about ?? pendingProfile?.about;
  const displayName = localName || name;
  const shortAddress = `${address.slice(0, 15)}…${address.slice(-6)}`;
  const editProfile = () => router.push("/settings/edit-profile");
  return (
    <Screen
      compact
      tab={tab}
      topInset={!tab}
      onScroll={tab ? onScroll : undefined}
    >
      <View style={styles.hero}>
        <View style={[styles.banner, { backgroundColor: colors.accentSoft }]}>
          {!reduceTransparency && (
            <LinearGradient
              colors={[colors.heroStart, colors.accentSoft, colors.heroEnd]}
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
          {!tab && (
            <GlassBackButton
              style={styles.bannerBack}
              onPress={() => {
                if (router.canGoBack()) router.back();
                else router.replace("/people");
              }}
            />
          )}
          <View style={styles.bannerTools}>
            {tab && (
              <CompactAction
                icon="settings"
                iconOnly
                label={t("navigation:settings")}
                onPress={() => router.push("/settings")}
              />
            )}
            <CompactAction
              icon="qr"
              iconOnly
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
          </View>
        </View>
        <View style={styles.identityLine}>
          <View style={[styles.avatar, { backgroundColor: colors.background }]}>
            <PersonAvatar
              publicKey={publicKey}
              name={displayName}
              photo={photo}
              hasName={Boolean(localName || contact?.name || profile?.name)}
              size="xl"
            />
          </View>
          <View style={styles.identity}>
            <Ink
              kind="heading"
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
            {profile?.name && profile.name !== name && (
              <Ink muted kind="caption">
                {profile.name}
              </Ink>
            )}
            {details.name && details.name !== profile?.name && (
              <Ink muted kind="caption">
                @{details.name}
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
          <CompactAction
            icon="key"
            label={t("common:address")}
            onPress={() => showIdentitySheet("address")}
          />
        </View>
      ) : (
        <View style={styles.actions}>
          {chatsEnabled && (
            <CompactAction
              prominent
              style={styles.primary}
              icon="chat"
              label={t("contacts:message")}
              disabled={block.blocked}
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
            disabled={block.blocked}
            onPress={() =>
              router.push({
                pathname: "/call/[key]",
                params: { key: publicKey },
              })
            }
          />
        </View>
      )}
      {pendingProfile && (
        <View style={[styles.status, { borderColor: colors.line }]}>
          <Icon name="connection" size={16} />
          <Ink kind="caption" muted style={styles.primary}>
            {t("messenger:pending")}
          </Ink>
          <CompactAction
            icon="edit"
            iconOnly
            label={t("common:retry")}
            disabled={stage !== "idle"}
            onPress={editProfile}
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
      {!block.blocked &&
        !avatars.autoLoads(publicKey) &&
        !allowImages &&
        Boolean(profile?.picture || details.banner) && (
          <CompactAction
            icon="download"
            label={t("messenger:loadImages")}
            onPress={() => setAllowImages(true)}
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
        <SettingsGroup>
          {!block.blocked && (
            <SettingsRow
              title={t(contact ? "messenger:nickname" : "messenger:savePerson")}
              detail={contact?.name || undefined}
              onPress={() => setNickname(contact?.name ?? "")}
            />
          )}
          {nickname !== undefined && !block.blocked && (
            <View style={styles.card}>
              <GlassInput
                label={t("messenger:nickname")}
                hint={t("messenger:nicknameHelp")}
                value={nickname}
                onChangeText={setNickname}
                maxLength={128}
              />
              <View style={styles.actions}>
                <Action variant="soft" onPress={() => setNickname(undefined)}>
                  {t("common:cancel")}
                </Action>
                <Action
                  onPress={() =>
                    write(() => {
                      db.transaction(() => {
                        if (contactByKey(db, publicKey).get())
                          updateContactPreferences(db, publicKey, {
                            name: nickname.trim(),
                          });
                        else saveContact(db, publicKey, nickname.trim());
                      });
                      setNickname(undefined);
                    })
                  }
                >
                  {t("contacts:save")}
                </Action>
              </View>
            </View>
          )}
          {contact && (
            <>
              <SettingsRow
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
              {!block.blocked && (
                <>
                  <SettingsRow
                    title={t("settings:photoChange")}
                    detail={t("settings:photoLocalHelp")}
                    onPress={() => setPicking(true)}
                  />
                  {avatars.hasOverride(publicKey) && (
                    <SettingsRow
                      title={t("settings:photoRemove")}
                      onPress={() =>
                        write(() => avatars.saveOverride(publicKey, null))
                      }
                    />
                  )}
                  <SettingsRow
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
              <SettingsRow
                title={t("messenger:removePerson")}
                onPress={() =>
                  Alert.alert(t("messenger:removePerson"), undefined, [
                    { text: t("common:cancel"), style: "cancel" },
                    {
                      text: t("messenger:removePerson"),
                      style: "destructive",
                      onPress: () =>
                        write(() =>
                          db
                            .delete(contacts)
                            .where(eq(contacts.publicKey, publicKey))
                            .run(),
                        ),
                    },
                  ])
                }
              />
            </>
          )}
          <SettingsRow title={block.label} onPress={block.onPress} />
        </SettingsGroup>
      )}
      {!own && !block.blocked && <PersonContext publicKey={publicKey} />}
      {notice && <Ink accessibilityLiveRegion="polite">{notice}</Ink>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: space.xs },
  banner: { height: 128, borderRadius: 18, overflow: "hidden" },
  bannerBack: { position: "absolute", start: space.sm, top: space.sm },
  bannerTools: {
    position: "absolute",
    top: space.sm,
    end: space.sm,
    flexDirection: "row",
    gap: space.xs,
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
    gap: space.xs,
    paddingHorizontal: space.sm,
    marginTop: -38,
  },
  avatar: { padding: 4, borderRadius: radius.round },
  identity: {
    maxWidth: "100%",
    alignItems: "center",
    gap: 2,
    paddingBottom: space.xs,
  },
  name: { fontSize: 25, letterSpacing: -0.5, textAlign: "center" },
  fallbackName: { fontSize: 18, letterSpacing: 0 },
  badge: { flexDirection: "row", alignItems: "center", gap: space.xs },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: space.sm,
  },
  primary: { flex: 1 },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.xs,
  },
  details: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.md,
    gap: space.sm,
  },
  link: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 44,
  },
  addressTrigger: {
    minHeight: 44,
    textAlignVertical: "center",
    writingDirection: "ltr",
  },
  card: { padding: space.md, gap: space.sm },
});
