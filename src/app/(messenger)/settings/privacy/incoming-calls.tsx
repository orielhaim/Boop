import { ScreenHeader } from "@/components/navigation/screen-header";
import { asc, eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { router } from "expo-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useDialog } from "@/components/ui/dialog";
import { SettingsMenuRow } from "@/components/settings/menu-row";
import { ListGroup, ListRow } from "@/components/ui/list-group";
import { Screen } from "@/components/ui/kit";
import { usePrivacy } from "@/components/ui/privacy-actions";
import { contacts } from "@/db/schema";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export default function IncomingCalls() {
  const { t } = useTranslation(namespaces);
  const dialog = useDialog();
  const { db } = useLocal();
  const privacy = usePrivacy();
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
      navigationHeader={<ScreenHeader title={t("security:incomingCalls")} />}
    >
      <ListGroup>
        <SettingsMenuRow
          title={t("security:whoCanCall")}
          value={privacy.preferences().calls}
          options={[
            { value: "everyone", label: t("security:everyone") },
            { value: "contacts", label: t("security:contactsOnly") },
            { value: "nobody", label: t("security:nobody") },
          ]}
          onChange={(value) => {
            try {
              privacy.set("calls", value);
            } catch {
              void dialog.show({
                title: t("security:privacyWriteFailed"),
                tone: "error",
              });
            }
          }}
        />
      </ListGroup>
      <ListGroup title={t("security:videoAllowlist")}>
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
