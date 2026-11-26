import { router } from "expo-router";
import { useSyncExternalStore } from "react";
import { useWindowDimensions, View } from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ListGroup, ListRow } from "@/components/ui/list-group";
import {
  CategoryIcon,
  type SettingsCategory,
} from "@/components/ui/category-icon";
import { PersonAvatar } from "@/components/people/person-avatar";
import { ProfileBannerArtwork } from "@/components/people/profile-banner-artwork";
import { usePerson } from "@/components/people/use-person";
import { useIdentitySheet } from "@/components/people/identity-sheet";
import { GlassBackButton } from "@/components/ui/back-button";
import { Ink } from "@/components/ui/kit";
import { CompactAction } from "@/components/ui/messenger-ui";
import { ScreenInsets } from "@/components/ui/screen-insets";
import { ParallaxScrollView } from "@/components/ui/templates/parallax-header/components/AnimatedScrollView";
import { useAvatar } from "@/core/avatars/use-avatar";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { useTheme } from "@/theme";
import { CountBadge } from "@/components/kinetik/count-badge";
import { countSecurityItems } from "@/components/devices/presentation";

const categoryRows = [
  {
    category: "appearance",
    titleKey: "settings:appearance",
    detailKey: "settings:categoryAppearanceHelp",
    route: "/settings/appearance",
  },
  {
    category: "calls",
    titleKey: "settings:calls",
    detailKey: "settings:categoryCallsHelp",
    route: "/settings/calls",
  },
  {
    category: "audio",
    titleKey: "audio:settings",
    detailKey: "settings:categoryAudioHelp",
    route: "/settings/playback",
  },
  {
    category: "storage",
    titleKey: "storage:title",
    detailKey: "settings:categoryStorageHelp",
    route: "/settings/storage",
  },
  {
    category: "language",
    titleKey: "settings:language",
    detailKey: "settings:categoryLanguageHelp",
    route: "/settings/language",
  },
  {
    category: "identity",
    titleKey: "settings:identity",
    detailKey: "settings:categoryIdentityHelp",
    route: "/settings/identity",
  },
  {
    category: "devices",
    titleKey: "devices:title",
    detailKey: "devices:category",
    route: "/settings/devices",
  },
  {
    category: "privacy",
    titleKey: "settings:privacy",
    detailKey: "settings:categoryPrivacyHelp",
    route: "/settings/privacy",
  },
  {
    category: "connections",
    titleKey: "settings:connections",
    detailKey: "settings:categoryConnectionsHelp",
    route: "/settings/connections",
  },
  {
    category: "plugins",
    titleKey: "settings:plugins",
    detailKey: "settings:torrentsDescription",
    route: "/settings/plugins",
  },
  {
    category: "about",
    titleKey: "settings:about",
    detailKey: "settings:categoryAboutHelp",
    route: "/settings/about",
  },
] as const satisfies readonly {
  category: SettingsCategory;
  titleKey: string;
  detailKey: string;
  route: Parameters<typeof router.push>[0];
}[];

function CategoryRow({
  category,
  title,
  detail,
  count,
  onPress,
}: {
  category: SettingsCategory;
  title: string;
  detail: string;
  count?: number;
  onPress: () => void;
}) {
  return (
    <ListRow
      title={title}
      detail={detail}
      leading={<CategoryIcon category={category} />}
      trailing={count ? <CountBadge count={count} size="compact" /> : undefined}
      onPress={onPress}
      showChevron={false}
    />
  );
}

export default function Settings() {
  const { t } = useTranslation(namespaces);
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  const { top } = useSafeAreaInsets();
  const bannerHeight = top + Math.max(132, Math.min(170, height * 0.19));
  const { identity, initialProfile, profileEditor, deviceController } =
    useLocal();
  const showIdentitySheet = useIdentitySheet();
  const attention = countSecurityItems(
    useSyncExternalStore(deviceController.subscribe, deviceController.getState),
  );
  const {
    photo: publishedPhoto,
    name,
    profile,
  } = usePerson(identity.publicKey);
  const publishedBanner = useAvatar(identity.publicKey, true, true, true);
  const { draft, photoPreview, bannerPreview } = useSyncExternalStore(
    profileEditor.subscribe,
    profileEditor.getSnapshot,
  );
  const displayName = draft?.name || name;
  const photo =
    draft?.photo.kind === "remove"
      ? undefined
      : (photoPreview ?? publishedPhoto);
  const banner =
    draft?.banner?.kind === "remove"
      ? undefined
      : (bannerPreview ?? publishedBanner);
  const hasName = Boolean(
    draft?.name || (profile ? profile.name : initialProfile.name),
  );

  return (
    <ScreenInsets edges={["bottom"]} style={styles.screen}>
      <ParallaxScrollView
        bodyStyle={styles.body}
        headerMaxHeight={bannerHeight}
        headerOverlap={44}
        backgroundColor={colors.background}
        header={
          <View style={styles.banner}>
            <ProfileBannerArtwork source={banner} />
          </View>
        }
        headerControls={
          <SafeAreaView
            edges={["top", "left", "right"]}
            pointerEvents="box-none"
            style={styles.controls}
          >
            <GlassBackButton
              onPress={() => {
                if (router.canGoBack()) router.back();
                else router.replace("/");
              }}
            />
            <View style={styles.bannerActions}>
              <CompactAction
                icon="edit"
                label={t("settings:editProfile")}
                onPress={() => router.push("/settings/edit-profile")}
              />
              <CompactAction
                icon="qr"
                iconOnly
                label={t("security:showIdentityQr")}
                onPress={() => showIdentitySheet("qr")}
              />
            </View>
          </SafeAreaView>
        }
      >
        <SafeAreaView edges={["left", "right"]} style={styles.content}>
          <View style={styles.identity}>
            <View style={styles.avatar}>
              <PersonAvatar
                size="xxl"
                publicKey={identity.publicKey}
                name={displayName}
                photo={photo}
                hasName={hasName}
              />
            </View>
            <Ink
              accessibilityRole="header"
              kind={hasName ? "profileName" : "body"}
              numberOfLines={2}
              style={styles.name}
            >
              {displayName}
            </Ink>
          </View>
          {[
            categoryRows.slice(0, 5),
            categoryRows.slice(5, 9),
            categoryRows.slice(9),
          ].map((group) => (
            <ListGroup key={group[0]?.category} dividers="none">
              {group.map((row) => (
                <CategoryRow
                  key={row.category}
                  category={row.category}
                  title={t(row.titleKey)}
                  detail={
                    row.category === "devices" && attention
                      ? t("devices:attentionCount", { count: attention })
                      : t(row.detailKey)
                  }
                  count={row.category === "devices" ? attention : undefined}
                  onPress={() => router.push(row.route)}
                />
              ))}
            </ListGroup>
          ))}
        </SafeAreaView>
      </ParallaxScrollView>
    </ScreenInsets>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  banner: {
    flex: 1,
    backgroundColor: theme.colors.selected,
  },
  controls: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.sm,
    gap: theme.space.sm,
  },
  bannerActions: {
    flexDirection: "row",
    gap: theme.space.sm,
  },
  body: { flex: 1 },
  content: {
    paddingHorizontal: theme.space.lg,
    paddingBottom: theme.space.xxl,
    gap: theme.space.md,
  },
  identity: {
    alignItems: "center",
    paddingHorizontal: theme.space.lg,
    paddingBottom: theme.space.sm,
  },
  name: { textAlign: "center", marginTop: theme.space.xs },
  avatar: {
    padding: 4,
    borderRadius: theme.radius.round,
    backgroundColor: theme.colors.background,
  },
}));
