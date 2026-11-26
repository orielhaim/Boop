import { desc, eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator } from "react-native";
import { conversationRoute } from "@/components/messages/marmot-inbox";
import { useMarmotWindow } from "@/components/messages/marmot-window";
import { Action } from "@/components/ui/kit";
import { ListGroup, ListRow } from "@/components/ui/list-group";
import { QuietState } from "@/components/ui/messenger-ui";
import { marmot, type MarmotChatList } from "@/core/marmot/native";
import { callHistory } from "@/db/schema";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export function PersonCallHistory({ publicKey }: { publicKey: string }) {
  const { t, i18n } = useTranslation(namespaces);
  const { db } = useLocal();
  const { data: calls } = useLiveQuery(
    db
      .select()
      .from(callHistory)
      .where(eq(callHistory.peerKey, publicKey))
      .orderBy(desc(callHistory.startedAt))
      .limit(3),
    [db, publicKey],
  );
  if (!calls.length) return null;
  const format = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <ListGroup title={t("calls:recents")}>
      {calls.map((call) => (
        <ListRow
          key={call.id}
          icon={call.outcome === "missed" ? "missed" : call.direction}
          title={t(
            call.direction === "incoming" ? "calls:incoming" : "calls:call",
          )}
          detail={format.format(call.startedAt)}
        />
      ))}
    </ListGroup>
  );
}

const openInbox = () => marmot.openChatList("chats");
const openArchive = () => marmot.openChatList("archived");
const MEMBERSHIP_BATCH_SIZE = 16;
type GroupRow = MarmotChatList["rows"][number];

export function PersonGroups({ publicKey }: { publicKey: string }) {
  const { t } = useTranslation(namespaces);
  const { identity, lock, marmotSession, privacy } = useLocal();
  const inbox = useMarmotWindow(openInbox);
  const archive = useMarmotWindow(openArchive);
  const inboxSnapshot = inbox.snapshot;
  const archiveSnapshot = archive.snapshot;
  const [result, setResult] = useState<{
    inbox: MarmotChatList;
    archive: MarmotChatList;
    groups: GroupRow[];
  }>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const paging = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!inboxSnapshot || !archiveSnapshot) return;
    const session = marmotSession.revision();
    let cancelled = false;
    const isCurrent = () => {
      const state = lock.getState();
      return (
        !cancelled &&
        state.active &&
        !state.locked &&
        !privacy.isBlocked(publicKey) &&
        marmotSession.revision() === session
      );
    };
    const rows = new Map<string, GroupRow>();
    for (const row of [...inboxSnapshot.rows, ...archiveSnapshot.rows]) {
      if (row.kind === "group" && row.membership === "member" && !row.invited)
        rows.set(row.id, row);
    }
    const groups = [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    void (async () => {
      const matches: GroupRow[] = [];
      for (
        let first = 0;
        first < groups.length;
        first += MEMBERSHIP_BATCH_SIZE
      ) {
        if (!isCurrent()) return;
        const batch = groups.slice(first, first + MEMBERSHIP_BATCH_SIZE);
        const ids = batch.map(({ id }) => id);
        const members = await marmot
          .groupMemberIds(ids)
          .catch(async (): Promise<Record<string, string[]>> => {
            if (!isCurrent()) return {};
            const results = await Promise.allSettled(
              ids.map((id) => marmot.groupMemberIds([id])),
            );
            return Object.assign(
              {},
              ...results.flatMap((entry) =>
                entry.status === "fulfilled" ? [entry.value] : [],
              ),
            );
          });
        matches.push(
          ...batch.filter(({ id }) => {
            const roster = members[id];
            return (
              roster?.includes(identity.publicKey) && roster.includes(publicKey)
            );
          }),
        );
      }
      if (isCurrent()) {
        setResult({
          inbox: inboxSnapshot,
          archive: archiveSnapshot,
          groups: matches,
        });
      }
    })().catch(() => {
      if (isCurrent()) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [
    archiveSnapshot,
    identity.publicKey,
    inboxSnapshot,
    lock,
    marmotSession,
    privacy,
    publicKey,
    retry,
  ]);

  const groups =
    result?.inbox === inboxSnapshot && result?.archive === archiveSnapshot
      ? result?.groups
      : undefined;
  const hasMore = inboxSnapshot?.hasMoreAfter || archiveSnapshot?.hasMoreAfter;

  async function loadMore() {
    if (paging.current) return;
    paging.current = true;
    setLoadingMore(true);
    try {
      await Promise.all([
        inboxSnapshot?.hasMoreAfter ? inbox.window?.page("forward") : undefined,
        archiveSnapshot?.hasMoreAfter
          ? archive.window?.page("forward")
          : undefined,
      ]);
    } catch {
      setFailed(true);
    } finally {
      paging.current = false;
      setLoadingMore(false);
    }
  }

  if (failed || inbox.error || archive.error) {
    return (
      <>
        <QuietState icon="people" title={t("common:unavailable")} />
        <Action
          onPress={() => {
            setFailed(false);
            if (inbox.error) inbox.retry();
            if (archive.error) archive.retry();
            setRetry((current) => current + 1);
          }}
        >
          {t("common:retry")}
        </Action>
      </>
    );
  }
  if (!groups) return <ActivityIndicator />;
  return (
    <>
      {groups.length > 0 ? (
        <ListGroup>
          {groups.map((group) => (
            <ListRow
              key={group.id}
              icon="people"
              title={group.title || t("messages:marmot.group")}
              onPress={() =>
                router.push(conversationRoute(group.id, "details"))
              }
            />
          ))}
        </ListGroup>
      ) : !hasMore ? (
        <QuietState icon="people" title={t("messenger:noSharedGroups")} />
      ) : null}
      {hasMore && (
        <Action disabled={loadingMore} onPress={() => void loadMore()}>
          {t("messages:marmot.loadMore")}
        </Action>
      )}
    </>
  );
}
