import { desc, eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { conversationRoute } from "@/components/messages/marmot-inbox";
import { useMarmotWindow } from "@/components/messages/marmot-window";
import { marmot } from "@/core/marmot/native";
import { callHistory } from "@/db/schema";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";

const openChats = () => marmot.openChatList("chats");

export function PersonContext({ publicKey }: { publicKey: string }) {
  const { t, i18n } = useTranslation(namespaces);
  const { db, identity, marmotSession } = useLocal();
  const enabled = useChatsEnabled();
  const { data: calls } = useLiveQuery(
    db
      .select()
      .from(callHistory)
      .where(eq(callHistory.peerKey, publicKey))
      .orderBy(desc(callHistory.startedAt))
      .limit(3),
    [db, publicKey],
  );
  const [show, setShow] = useState(false);
  const { snapshot } = useMarmotWindow(openChats, enabled && show);
  const [matches, setMatches] = useState<{ id: string; name: string }[]>();
  useEffect(() => {
    if (!snapshot || !show) return;
    let live = true;
    const groups = snapshot.rows
      .filter(
        (row) =>
          row.kind === "group" && row.membership === "member" && !row.invited,
      )
      .slice(0, 16);
    void (async () => {
      const found = [];
      for (const row of groups) {
        if (!live) return;
        try {
          await marmotSession.ready();
          const group = await marmot.groupDetails(row.id);
          if (
            group.membership === "member" &&
            !group.pendingInvitation &&
            group.members.some((person) => person.id === identity.publicKey) &&
            group.members.some((person) => person.id === publicKey)
          )
            found.push({
              id: row.id,
              name: group.name || t("messages:marmot.group"),
            });
        } catch {}
      }
      if (live) setMatches(found);
    })();
    return () => {
      live = false;
    };
  }, [identity.publicKey, marmotSession, publicKey, show, snapshot, t]);
  const format = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <>
      {calls.length > 0 && (
        <SettingsGroup title={t("calls:recents")}>
          {calls.map((call) => (
            <SettingsRow
              key={call.id}
              icon={call.outcome === "missed" ? "missed" : call.direction}
              title={t(
                call.direction === "incoming" ? "calls:incoming" : "calls:call",
              )}
              detail={format.format(call.startedAt)}
            />
          ))}
        </SettingsGroup>
      )}
      {enabled && (
        <SettingsGroup>
          <SettingsRow
            title={t("messenger:sharedGroups")}
            onPress={() => {
              setMatches(undefined);
              setShow(!show);
            }}
          />
          {show &&
            matches?.map((group) => (
              <SettingsRow
                key={group.id}
                title={group.name}
                onPress={() =>
                  router.push(conversationRoute(group.id, "details"))
                }
              />
            ))}
          {show && matches?.length === 0 && (
            <SettingsRow title={t("messenger:noSharedGroups")} />
          )}
        </SettingsGroup>
      )}
    </>
  );
}
