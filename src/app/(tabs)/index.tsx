import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { useCalendars } from "expo-localization";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import {
  Avatar,
  Card,
  Empty,
  Header,
  Icon,
  IconButton,
  Ink,
  layout,
  Row,
  Screen,
  Section,
} from "@/components/ui/kit";
import { PeerActions } from "@/components/ui/peer-actions";
import { nameOrAddress, useContacts } from "@/db/contacts";
import { callList } from "@/db/queries";
import { namespaces, resolveLanguage } from "@/i18n";
import { formatDateTime, isolateText } from "@/i18n/format";
import { useLocal } from "@/services/local";
import { radius, space, useTheme } from "@/theme";

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

function call(key: string) {
  router.push({ pathname: "/call/[key]", params: { key } });
}

export default function Calls() {
  const { t, i18n } = useTranslation(namespaces);
  const locale = resolveLanguage(i18n.resolvedLanguage);
  const calendar = useCalendars()[0];
  const [actions, setActions] = useState(false);
  const { db } = useLocal();
  const { colors } = useTheme();
  const contacts = useContacts();
  const { data: calls } = useLiveQuery(callList(db), [db, contacts]);
  const favorites = contacts.filter((contact) => contact.favorite);

  return (
    <Screen tab>
      <Header title={t("navigation:calls")}>
        <IconButton
          icon="settings"
          label={t("navigation:settings")}
          onPress={() => router.push("/settings")}
        />
        <IconButton
          icon="add"
          label={t("calls:newCall")}
          onPress={() => setActions(true)}
        />
      </Header>
      <PeerActions mode="call" open={actions} onOpenChange={setActions} />
      {favorites.length ? (
        <>
          <Section>{t("contacts:favorites")}</Section>
          <View style={layout.row}>
            {favorites.map((contact) => (
              <Pressable
                key={contact.publicKey}
                accessibilityRole="button"
                accessibilityLabel={t("calls:callPerson", {
                  name: isolateText(contact.name),
                })}
                onPress={() => call(contact.publicKey)}
                style={({ pressed }) => [
                  styles.favorite,
                  pressed && { backgroundColor: colors.accentSoft },
                ]}
              >
                <Avatar name={contact.name} uri={contact.avatarUrl} size="lg" />
                <Ink kind="caption" numberOfLines={1}>
                  {contact.name}
                </Ink>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      <Section>{t("calls:recents")}</Section>
      {calls.length ? (
        <Card>
          {calls.map((entry) => {
            const name = nameOrAddress(entry.name, entry.peerKey);
            const unsuccessful =
              entry.outcome !== "answered" && entry.outcome !== "completed";
            return (
              <Row
                key={entry.id}
                title={name}
                leading={<Avatar name={name} uri={entry.avatarUrl} />}
                leadingAction={{
                  label: t("contacts:openProfile", { name: isolateText(name) }),
                  onPress: () =>
                    router.push({
                      pathname: "/contact/[key]",
                      params: { key: entry.peerKey },
                    }),
                }}
                detail={`${t(outcomes[entry.outcome])} · ${isolateText(formatDateTime(entry.startedAt, locale, typeof calendar?.uses24hourClock === "boolean" ? !calendar.uses24hourClock : undefined))}`}
                accessibilityLabel={t("calls:callPerson", {
                  name: isolateText(name),
                })}
                onPress={() => call(entry.peerKey)}
                trailing={
                  <Icon
                    name={unsuccessful ? "missed" : entry.direction}
                    color={unsuccessful ? colors.danger : colors.accent}
                  />
                }
              />
            );
          })}
        </Card>
      ) : (
        <Empty
          icon="history"
          title={t("calls:noRecents")}
          detail={t("calls:emptyHistory")}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  favorite: {
    width: 80,
    minHeight: 80,
    justifyContent: "center",
    alignItems: "center",
    gap: space.xs,
    borderRadius: radius.input,
  },
});
