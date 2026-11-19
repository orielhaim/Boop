import { asc, eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { router } from "expo-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { Screen } from "@/components/ui/kit";
import { contacts } from "@/db/schema";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";

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
    <Screen>
      <SettingsGroup title={t("security:autoAllowed")}>
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
          <SettingsRow title={t("security:noApproved")} />
        )}
      </SettingsGroup>
    </Screen>
  );
}
