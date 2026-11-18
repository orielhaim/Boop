import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { getLocales } from "expo-localization";
import { router } from "expo-router";
import { useState } from "react";
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
import { useLocal } from "@/services/local";
import { radius, space, useTheme } from "@/theme";

const timeFormat = new Intl.DateTimeFormat(getLocales()[0]?.languageTag, {
  dateStyle: "medium",
  timeStyle: "short",
});

const outcomes = {
  answered: "Answered",
  completed: "Completed",
  missed: "Missed",
  rejected: "Declined",
  failed: "Connection failed",
  cancelled: "Cancelled",
  busy: "Busy",
  unanswered: "No answer",
  "remote-disconnected": "Connection lost",
};

function call(key: string) {
  router.push({ pathname: "/call/[key]", params: { key } });
}

export default function Calls() {
  const [actions, setActions] = useState(false);
  const { db } = useLocal();
  const { colors } = useTheme();
  const contacts = useContacts();
  const { data: calls } = useLiveQuery(callList(db), [db, contacts]);
  const favorites = contacts.filter((contact) => contact.favorite);

  return (
    <Screen tab>
      <Header title="Calls">
        <IconButton
          icon="settings"
          label="Settings"
          onPress={() => router.push("/settings")}
        />
        <IconButton
          icon="add"
          label="New call"
          onPress={() => setActions(true)}
        />
      </Header>
      <PeerActions mode="call" open={actions} onOpenChange={setActions} />
      {favorites.length ? (
        <>
          <Section>Favorites</Section>
          <View style={layout.row}>
            {favorites.map((contact) => (
              <Pressable
                key={contact.publicKey}
                accessibilityRole="button"
                accessibilityLabel={`Call ${contact.name}`}
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
      <Section>Recents</Section>
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
                  label: `Open profile for ${name}`,
                  onPress: () =>
                    router.push({
                      pathname: "/contact/[key]",
                      params: { key: entry.peerKey },
                    }),
                }}
                detail={`${outcomes[entry.outcome]} · ${timeFormat.format(entry.startedAt)}`}
                accessibilityLabel={`Call ${name}`}
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
          title="No recent calls"
          detail="Your calls will appear here."
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
