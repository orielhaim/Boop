import { desc, eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { conversationRoute } from "@/components/messages/marmot-inbox";
import { useMarmotChatLists } from "@/components/messages/marmot-chat-lists";
import { marmot } from "@/core/marmot/native";
import { callHistory } from "@/db/schema";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";

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
  const {
    inbox: { snapshot },
  } = useMarmotChatLists();
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
      try {
        const ids = groups.map(({ id }) => id);
        if (!ids.length) {
          setMatches([]);
          return;
        }
        await marmotSession.ready();
        if (!live) return;
        const members = await marmot
          .groupMemberIds(ids)
          .catch(async (): Promise<Record<string, string[]>> => {
            if (!live) return {};
            const results = await Promise.allSettled(
              ids.map((id) => marmot.groupMemberIds([id])),
            );
            return Object.assign(
              {},
              ...results.flatMap((result) =>
                result.status === "fulfilled" ? [result.value] : [],
              ),
            );
          });
        if (!live) return;
        setMatches(
          groups.flatMap((row) => {
            const ids = members[row.id];
            return ids?.includes(identity.publicKey) && ids.includes(publicKey)
              ? [{ id: row.id, name: row.title || t("messages:marmot.group") }]
              : [];
          }),
        );
      } catch {
        if (live) setMatches([]);
      }
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
