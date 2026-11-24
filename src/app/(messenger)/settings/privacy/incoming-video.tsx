import { ScreenHeader } from "@/components/navigation/screen-header";
import { asc, eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { router } from "expo-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ListGroup, ListRow } from "@/components/ui/list-group";
import { Screen } from "@/components/ui/kit";
import { contacts } from "@/db/schema";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export default function ContactPreferences() {
  const { t } = useTranslation(namespaces);
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
    <Screen
      navigationHeader={<ScreenHeader title={t("security:incomingVideo")} />}
    >
      <ListGroup title={t("security:autoAllowed")}>
        {data.length ? (
          data.map((contact) => (
            <ListRow
              key={contact.publicKey}
              title={contact.name}
              icon="person"
              onPress={() =>
                router.push({
                  pathname: "/person/[key]",
                  params: { key: contact.publicKey },
                })
              }
            />
          ))
        ) : (
          <ListRow title={t("security:noApproved")} />
        )}
      </ListGroup>
    </Screen>
  );
}
