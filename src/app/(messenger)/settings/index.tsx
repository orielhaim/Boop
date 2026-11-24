import { router } from "expo-router";
import { useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ListGroup, ListRow } from "@/components/ui/list-group";
import {
  CategoryIcon,
  type SettingsCategory,
} from "@/components/ui/category-icon";
import { PersonAvatar } from "@/components/people/person-avatar";
import { usePerson } from "@/components/people/use-person";
import { GlassBackButton } from "@/components/ui/back-button";
import { Icon, Ink, Screen, tapFeedback } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { useTheme } from "@/theme";

const categoryRows = [
  {
    category: "appearance",
    titleKey: "settings:appearance",
    route: "/settings/appearance",
  },
  { category: "calls", titleKey: "settings:calls", route: "/settings/calls" },
  {
    category: "audio",
    titleKey: "audio:settings",
    route: "/settings/playback",
  },
  {
    category: "storage",
    titleKey: "storage:title",
    route: "/settings/storage",
  },
  {
    category: "language",
    titleKey: "settings:language",
    route: "/settings/language",
  },
  {
    category: "identity",
    titleKey: "settings:identity",
    route: "/settings/identity",
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
  { category: "about", titleKey: "settings:about", route: "/settings/about" },
] as const satisfies readonly {
  category: SettingsCategory;
  titleKey: string;
  detailKey?: string;
  route: Parameters<typeof router.push>[0];
}[];

function CategoryRow({
  category,
  title,
  detail,
  onPress,
}: {
  category: SettingsCategory;
  title: string;
  detail?: string;
  onPress: () => void;
}) {
  return (
    <ListRow
      title={title}
      detail={detail}
      leading={<CategoryIcon category={category} />}
      onPress={onPress}
      showChevron={false}
    />
  );
}

export default function Settings() {
  const { t } = useTranslation(namespaces);
  const { identity, profileEditor } = useLocal();
  const {
    photo: publishedPhoto,
    name,
    profile,
  } = usePerson(identity.publicKey);
  const { draft, photoPreview } = useSyncExternalStore(
    profileEditor.subscribe,
    profileEditor.getSnapshot,
  );
  const displayName = draft?.name || name;
  const photo =
    draft?.photo.kind === "remove"
      ? undefined
      : (photoPreview ?? publishedPhoto);
  const { colors } = useTheme();
  const edit = () => router.push("/settings/edit-profile");

  return (
    <Screen compact topInset>
      <View style={styles.header}>
        <GlassBackButton
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/profile");
          }}
        />
        <Ink kind="screenTitle" accessibilityRole="header" style={styles.title}>
          {t("navigation:settings")}
        </Ink>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t("settings:editProfile")}, ${displayName}`}
        onPress={() => {
          tapFeedback();
          edit();
        }}
        style={({ pressed }) => [
          styles.profileCard,
          pressed && { backgroundColor: colors.pressed },
        ]}
      >
        <PersonAvatar
          size="lg"
          publicKey={identity.publicKey}
          name={displayName}
          photo={photo}
          hasName={Boolean(profile?.name || draft?.name)}
        />
        <View style={styles.profileCopy}>
          <Ink kind="rowTitle" numberOfLines={1}>
            {displayName}
          </Ink>
          <Ink kind="description" muted>
            {t("settings:editProfile")}
          </Ink>
        </View>
        <Icon name="edit" size={19} color={colors.muted} />
      </Pressable>

      <ListGroup dividers="inset">
        {categoryRows.slice(0, 5).map((row) => (
          <CategoryRow
            key={row.category}
            category={row.category}
            title={t(row.titleKey)}
            detail={"detailKey" in row ? t(row.detailKey) : undefined}
            onPress={() => router.push(row.route)}
          />
        ))}
      </ListGroup>
      <ListGroup dividers="inset">
        {categoryRows.slice(5, 8).map((row) => (
          <CategoryRow
            key={row.category}
            category={row.category}
            title={t(row.titleKey)}
            detail={"detailKey" in row ? t(row.detailKey) : undefined}
            onPress={() => router.push(row.route)}
          />
        ))}
      </ListGroup>
      <ListGroup dividers="inset">
        <CategoryRow
          category="about"
          title={t("settings:about")}
          onPress={() => router.push("/settings/about")}
        />
      </ListGroup>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
  },
  title: { flex: 1 },
  profileCard: {
    minHeight: 82,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    padding: theme.space.md,
    borderRadius: theme.radius.group,
    backgroundColor: theme.colors.grouped,
  },
  profileCopy: { flex: 1, gap: theme.space.xs },
}));
