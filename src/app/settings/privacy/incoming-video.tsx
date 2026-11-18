import { asc, eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { router } from "expo-router";
import { useMemo } from "react";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { Screen } from "@/components/ui/kit";
import { contacts } from "@/db/schema";
import { useLocal } from "@/services/local";

export default function ContactPreferences() {
  const { db } = useLocal();
  const query = useMemo(
    () =>
      db
        .select()
        .from(contacts)
        .where(eq(contacts.allowIncomingVideo, true))
        .orderBy(asc(contacts.name)),
    [db],
  );
  const { data } = useLiveQuery(query, [query]);
  return (
    <Screen>
      <SettingsGroup title="Automatically allowed">
        {data.length ? (
          data.map((contact) => (
            <SettingsRow
              key={contact.publicKey}
              title={contact.name}
              icon="person"
              onPress={() =>
                router.push({
                  pathname: "/contact/[key]",
                  params: { key: contact.publicKey },
                })
              }
            />
          ))
        ) : (
          <SettingsRow title="No contacts approved" />
        )}
      </SettingsGroup>
    </Screen>
  );
}
