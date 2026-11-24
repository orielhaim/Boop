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
import { backButtonSize, GlassBackButton } from "@/components/ui/back-button";
import { Icon, Ink, Screen, tapFeedback } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { useTheme } from "@/theme";

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
  onPress,
}: {
  category: SettingsCategory;
  title: string;
  detail: string;
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${t("settings:editProfile")}, ${displayName}`}
          onPress={() => {
            tapFeedback();
            edit();
          }}
          style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
        >
          <View>
            <PersonAvatar
              size="xxl"
              publicKey={identity.publicKey}
              name={displayName}
              photo={photo}
              hasName={Boolean(profile?.name || draft?.name)}
            />
            <View style={styles.editBadge}>
              <Icon name="edit" size={14} color={colors.outgoingInk} />
            </View>
          </View>
          <Ink
            kind={profile?.name || draft?.name ? "profileName" : "body"}
            numberOfLines={2}
            style={styles.name}
          >
            {displayName}
          </Ink>
          <Ink kind="description" style={styles.editLabel}>
            {t("settings:editProfile")}
          </Ink>
        </Pressable>
      </View>

      {[
        categoryRows.slice(0, 5),
        categoryRows.slice(5, 8),
        categoryRows.slice(8),
      ].map((group) => (
        <ListGroup key={group[0]?.category} dividers="none">
          {group.map((row) => (
            <CategoryRow
              key={row.category}
              category={row.category}
              title={t(row.titleKey)}
              detail={t(row.detailKey)}
              onPress={() => router.push(row.route)}
            />
          ))}
        </ListGroup>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  identity: {
    flex: 1,
    marginEnd: backButtonSize,
    alignItems: "center",
    gap: theme.space.sm,
    paddingVertical: theme.space.sm,
  },
  pressed: { opacity: 0.75 },
  name: { textAlign: "center", marginTop: theme.space.xs },
  editLabel: { color: theme.colors.accent },
  editBadge: {
    position: "absolute",
    bottom: 0,
    end: 0,
    width: 29,
    height: 29,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.round,
    backgroundColor: theme.colors.outgoing,
    borderColor: theme.colors.background,
    borderWidth: 2,
  },
}));
