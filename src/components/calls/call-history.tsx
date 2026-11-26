import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { useCalendars } from "expo-localization";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import { Card, Icon, Row, Section, tapFeedback } from "@/components/ui/kit";
import { IllustratedEmptyState } from "@/components/ui/illustrated-empty-state";
import { PersonAvatar } from "@/components/people/person-avatar";
import { usePerson } from "@/components/people/use-person";
import { useAvatarVisibility } from "@/core/avatars/use-avatar";
import { callList } from "@/db/queries";
import type { callHistory } from "@/db/schema";
import { namespaces, resolveLanguage } from "@/i18n";
import { formatDateTime, isolateText } from "@/i18n/format";
import { useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";
import { CallSignalArtwork } from "./call-signal-artwork";

const outcomes = {
  answered: "calls:answered",
  completed: "calls:completed",
  missed: "calls:missed",
  rejected: "calls:declined",
  failed: "calls:failed",
  cancelled: "calls:cancelled",
  busy: "calls:busy",
  unanswered: "calls:unanswered",
  "remote-disconnected": "calls:disconnected",
} as const;

function openCall(key: string) {
  router.push({ pathname: "/call/[key]", params: { key } });
}

export function CallHistory({
  onScroll,
}: {
  onScroll?: React.ComponentProps<typeof Animated.FlatList>["onScroll"];
}) {
  const { t, i18n } = useTranslation(namespaces);
  const locale = resolveLanguage(i18n.resolvedLanguage);
  const calendar = useCalendars()[0];
  const { db } = useLocal();
  const calls = useLiveQuery(callList(db), [db]).data;
  const visibleAvatars = useAvatarVisibility<(typeof calls)[number]>(
    (entry) => entry.peerKey,
  );
  const { colors, reduceMotion } = useTheme();

  return (
    <Animated.FlatList
      {...visibleAvatars}
      data={calls}
      keyExtractor={(entry) => entry.id}
      onScroll={reduceMotion ? undefined : onScroll}
      scrollEventThrottle={16}
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      windowSize={3}
      contentContainerStyle={[
        styles.list,
        calls.length === 0 && styles.emptyList,
      ]}
      ListHeaderComponent={
        calls.length > 0 ? <Section>{t("calls:recents")}</Section> : undefined
      }
      renderItem={({ item: entry }) => (
        <CallHistoryRow
          entry={entry}
          label={t(outcomes[entry.outcome])}
          date={formatDateTime(
            entry.startedAt,
            locale,
            typeof calendar?.uses24hourClock === "boolean"
              ? !calendar.uses24hourClock
              : undefined,
          )}
          participantCount={t("calls:participantCount", {
            count: entry.participantKeys.length + 1,
          })}
          colors={colors}
        />
      )}
      ListEmptyComponent={
        <IllustratedEmptyState
          artwork={<CallSignalArtwork />}
          title={t("calls:noRecents")}
          detail={t("calls:emptyHistory")}
        />
      }
    />
  );
}

function CallHistoryRow({
  entry,
  label,
  date,
  participantCount,
  colors,
}: {
  entry: typeof callHistory.$inferSelect;
  label: string;
  date: string;
  participantCount: string;
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  const { t } = useTranslation(namespaces);
  const { contact, profile, photo, name } = usePerson(entry.peerKey, false);
  const unsuccessful =
    entry.outcome !== "answered" && entry.outcome !== "completed";
  const group = entry.participantKeys.length > 1;
  const detail = `${group ? `${participantCount} · ` : ""}${label} · ${isolateText(date)}`;

  return (
    <Card>
      <Row
        title={group ? t("calls:groupCall") : name}
        leading={
          <PersonAvatar
            publicKey={entry.peerKey}
            name={name}
            photo={photo}
            hasName={Boolean(contact?.name || profile?.name)}
          />
        }
        leadingAction={{
          label: t("contacts:openProfile", { name: isolateText(name) }),
          onPress: () =>
            router.push({
              pathname: "/person/[key]",
              params: { key: entry.peerKey },
            }),
        }}
        detail={detail}
        accessibilityLabel={t("calls:callPerson", {
          name: isolateText(name),
        })}
        onPress={() => {
          tapFeedback();
          openCall(entry.peerKey);
        }}
        trailing={
          <Icon
            name={unsuccessful ? "missed" : entry.direction}
            color={unsuccessful ? colors.danger : colors.accent}
          />
        }
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.lg,
    gap: space.xs,
  },
  emptyList: { flexGrow: 1, paddingBottom: space.sm },
});
