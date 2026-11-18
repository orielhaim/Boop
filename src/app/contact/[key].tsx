import { eq } from "drizzle-orm";
import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import {
  Action,
  Avatar,
  Card,
  Empty,
  Hero,
  Icon,
  IconButton,
  Ink,
  layout,
  Screen,
  Section,
} from "@/components/ui/kit";
import { parsePublicKey, toNpub } from "@/core/identity/keys";
import { useContact } from "@/db/contacts";
import { contacts } from "@/db/schema";
import { useLocal } from "@/services/local";
import { space } from "@/theme";

export default function ContactDetail() {
  const params = useLocalSearchParams<{ key: string }>();
  const key =
    typeof params.key === "string" ? parsePublicKey(params.key) : null;
  const contact = useContact(key ?? "");
  const { db } = useLocal();

  if (!key)
    return (
      <Screen>
        <Empty
          icon="person"
          title="Contact unavailable"
          detail="The address is invalid."
        />
      </Screen>
    );

  const address = toNpub(key);
  if (!contact)
    return (
      <Screen>
        <Section>Boop address</Section>
        <Card style={styles.key}>
          <Ink kind="caption" selectable>
            {address}
          </Ink>
        </Card>
        <Action
          onPress={() =>
            router.replace({ pathname: "/contact/new", params: { address } })
          }
        >
          Save as contact
        </Action>
      </Screen>
    );

  return (
    <Screen>
      <Hero>
        <View style={styles.profile}>
          <Avatar name={contact.name} uri={contact.avatarUrl} size="xl" />
          <Ink kind="title" accessibilityRole="header" style={styles.center}>
            {contact.name}
          </Ink>
          <IconButton
            icon={contact.favorite ? "favorite" : "star"}
            label={
              contact.favorite ? "Remove from favorites" : "Add to favorites"
            }
            onPress={() =>
              db
                .update(contacts)
                .set({ favorite: !contact.favorite })
                .where(eq(contacts.publicKey, contact.publicKey))
                .run()
            }
          />
        </View>
      </Hero>
      <View style={layout.row}>
        <Action
          onPress={() =>
            router.push({
              pathname: "/call/[key]",
              params: { key: contact.publicKey },
            })
          }
        >
          <Icon name="phone" />
          Call
        </Action>
        <Action
          onPress={() =>
            router.push({
              pathname: "/chat/[key]",
              params: { key: contact.publicKey },
            })
          }
        >
          <Icon name="chat" />
          Message
        </Action>
      </View>
      <Section>Boop address</Section>
      <Card style={styles.key}>
        <Ink kind="caption" selectable>
          {address}
        </Ink>
      </Card>
    </Screen>
  );
}
const styles = StyleSheet.create({
  center: { textAlign: "center" },
  profile: { alignItems: "center", gap: space.md },
  key: { padding: space.lg },
});
