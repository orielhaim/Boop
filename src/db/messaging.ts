import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias, type BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  quicknetHash,
  type TimeLockContent,
  type UnlockFailure,
} from "@/core/messaging/special-messages/timelock";
import * as schema from "./schema";
import { translationEngine } from "./translations";

const {
  messages,
  conversations,
  contacts,
  messageReactions,
  messageTimeLocks,
  blockedIdentities,
  communicationGrants,
  messageRequests,
} = schema;
const notBlocked = (
  key: typeof messages.peerKey | typeof conversations.peerKey,
) =>
  sql`NOT EXISTS (SELECT 1 FROM ${blockedIdentities} WHERE ${blockedIdentities.publicKey} = ${key})`;
type MessageRow = typeof messages.$inferSelect;
type ReadDatabase<TResult> = Pick<
  BaseSQLiteDatabase<"sync", TResult, typeof schema>,
  "select"
>;
type WriteDatabase<TResult> = Pick<
  BaseSQLiteDatabase<"sync", TResult, typeof schema>,
  "select" | "insert" | "update" | "delete"
>;

export type MessageCursor = Pick<MessageRow, "id" | "sentAt">;
export type Reaction = { author: string; emoji: string };
type LockedPresentation = Pick<
  typeof messageTimeLocks.$inferSelect,
  "requestedAt" | "roundTime" | "error"
>;
export type MessageRecord = MessageRow & {
  reactions: Reaction[];
  locked?: LockedPresentation;
};
type PendingUnlock = {
  messageId: string;
  peerKey: string;
  content: TimeLockContent;
  attempts: number;
};
export type MessageInput = Pick<
  MessageRow,
  "id" | "eventId" | "peerKey" | "direction" | "body" | "sentAt" | "replyTo"
> & {
  senderKey: string;
  recipientKey: string;
  rumorJson?: string;
  timeLock?: TimeLockContent;
};
type ReactionInput = Reaction & {
  eventId: string;
  peerKey: string;
  targetEventId: string;
};
export type HistoryOptions = {
  before?: MessageCursor;
  atOrBefore?: MessageCursor;
  atOrAfter?: MessageCursor;
  after?: MessageCursor;
  limit?: number;
};

function conversationQuery<TResult>(
  db: ReadDatabase<TResult>,
  target?: string,
) {
  const latest = alias(messages, "latest_message");
  const cached = schema.messageTranslations;
  const translatedPreview = target
    ? sql<string | null>`(SELECT ${cached.translatedText} FROM ${cached}
        WHERE ${cached.messageId} = ${latest.id} AND ${cached.targetLanguage} = ${target}
          AND ${latest.direction} = 'incoming'
          AND ${cached.engine} = ${translationEngine}
          AND ${cached.sourceLanguage} <> ${target} AND trim(${cached.translatedText}) <> ''
        ORDER BY ${cached.createdAt} DESC LIMIT 1)`
    : sql<string | null>`NULL`;
  const lastId = sql`(
    SELECT ${messages.id} FROM ${messages}
    WHERE ${messages.peerKey} = ${conversations.peerKey} AND ${messages.deletedAt} IS NULL
    ORDER BY ${messages.sentAt} DESC, ${messages.id} DESC LIMIT 1
  )`;
  return db
    .select({
      ...getTableColumns(conversations),
      unread: sql<number>`CASE WHEN ${notBlocked(conversations.peerKey)} THEN ${conversations.unread} ELSE 0 END`,
      name: contacts.name,
      avatarUrl: contacts.avatarUrl,
      preview: latest.body,
      lockedUntil: messageTimeLocks.requestedAt,
      translatedPreview,
      lastMessageAt: latest.sentAt,
      lastMessageId: latest.id,
      lastMessageDirection: latest.direction,
      lastMessageStatus: latest.status,
    })
    .from(conversations)
    .leftJoin(contacts, eq(conversations.peerKey, contacts.publicKey))
    .leftJoin(latest, eq(latest.id, lastId))
    .leftJoin(
      messageTimeLocks,
      and(
        eq(messageTimeLocks.messageId, latest.id),
        isNull(messageTimeLocks.openedAt),
      ),
    );
}

export type ConversationSummary = ReturnType<
  ReturnType<typeof conversationQuery>["all"]
>[number];

function liveMessage(peerKey: string) {
  return and(eq(messages.peerKey, peerKey), isNull(messages.deletedAt));
}

function rowKey(cursor: MessageCursor, comparison: "<" | "<=" | ">" | ">=") {
  return sql`(${messages.sentAt}, ${messages.id}) ${sql.raw(comparison)} (${cursor.sentAt}, ${cursor.id})`;
}

function cursor(row: MessageRow | undefined): MessageCursor | null {
  return row ? { id: row.id, sentAt: row.sentAt } : null;
}

export const maximumHistoryWindow = 300;
const pageLimit = (limit: number) =>
  Math.max(1, Math.min(maximumHistoryWindow, Math.floor(limit) || 1));

function ensureRoom<TResult>(
  db: WriteDatabase<TResult>,
  peerKey: string,
  updatedAt: number,
  deletedAt?: number,
) {
  return db
    .insert(conversations)
    .values({ peerKey, updatedAt, deletedAt })
    .onConflictDoNothing()
    .returning({ peerKey: conversations.peerKey })
    .get();
}

function recountUnread<TResult>(db: WriteDatabase<TResult>, peerKey: string) {
  db.update(conversations)
    .set({
      unread: sql`(SELECT count(*) FROM ${messages} WHERE ${messages.peerKey} = ${peerKey}
        AND ${messages.isUnread} = 1 AND ${messages.deletedAt} IS NULL)`,
    })
    .where(eq(conversations.peerKey, peerKey))
    .run();
}

export type MessagingRepository = ReturnType<typeof createMessagingRepository>;
type Change = {
  history?: readonly string[] | "all";
  summaries?: boolean;
  unread?: boolean;
  unlockQueue?: boolean;
};

export function createMessagingRepository<TResult>(
  db: BaseSQLiteDatabase<"sync", TResult, typeof schema>,
) {
  let revision = 0;
  let resetRevision = 0;
  const historyRevisions = new Map<string, number>();
  const listeners = new Set<(change: Change) => void>();

  function changed(change: Change) {
    if (change.history === "all") {
      resetRevision = ++revision;
      historyRevisions.clear();
    } else if (change.history) {
      for (const key of change.history) historyRevisions.set(key, ++revision);
    }
    for (const listener of listeners) listener(change);
  }

  function withReactions(peerKey: string, rows: MessageRow[]): MessageRecord[] {
    if (rows.length === 0) return [];
    const reactions = db
      .select({
        targetId: messageReactions.targetId,
        author: messageReactions.author,
        emoji: messageReactions.emoji,
      })
      .from(messageReactions)
      .where(
        and(
          eq(messageReactions.peerKey, peerKey),
          eq(messageReactions.removed, false),
          inArray(
            messageReactions.targetId,
            rows.map((row) => row.eventId ?? row.id),
          ),
        ),
      )
      .orderBy(asc(messageReactions.emoji), asc(messageReactions.author))
      .all();
    const grouped = new Map<string, Reaction[]>();
    for (const { targetId, ...reaction } of reactions) {
      const group = grouped.get(targetId);
      if (group) group.push(reaction);
      else grouped.set(targetId, [reaction]);
    }
    const lockedIds = rows
      .filter(({ contentType, body }) => contentType === "timelock" && !body)
      .map(({ id }) => id);
    const locked = lockedIds.length
      ? db
          .select({
            id: messageTimeLocks.messageId,
            requestedAt: messageTimeLocks.requestedAt,
            roundTime: messageTimeLocks.roundTime,
            error: messageTimeLocks.error,
          })
          .from(messageTimeLocks)
          .where(inArray(messageTimeLocks.messageId, lockedIds))
          .all()
      : [];
    const locks = new Map(locked.map(({ id, ...row }) => [id, row]));
    return rows.map((row) => ({
      locked: locks.get(row.id),
      ...row,
      reactions: grouped.get(row.eventId ?? row.id) ?? [],
    }));
  }

  function messageRow(peerKey: string, reference: string) {
    return db
      .select()
      .from(messages)
      .where(
        and(
          liveMessage(peerKey),
          or(eq(messages.id, reference), eq(messages.eventId, reference)),
        ),
      )
      .get();
  }

  function insertMessage(
    tx: WriteDatabase<TResult>,
    input: MessageInput,
    outgoing: boolean,
    clearDraft: boolean,
  ) {
    const { timeLock, ...record } = input;
    ensureRoom(tx, input.peerKey, input.sentAt);
    const isUnread = input.direction === "incoming";
    const stored = tx
      .insert(messages)
      .values({
        ...record,
        contentType: timeLock ? "timelock" : "text",
        body: timeLock ? "" : record.body,
        status: outgoing ? "pending" : isUnread ? "received" : "synced",
        isUnread,
      })
      .onConflictDoNothing()
      .returning({ id: messages.id })
      .get();
    // A duplicate sender copy says nothing about acceptance by the recipient's relays.
    if (!stored) return false;
    if (timeLock) {
      const { ciphertext, chainHash, unlockRound, requestedAt, roundTime } =
        timeLock;
      tx.insert(messageTimeLocks)
        .values({
          messageId: stored.id,
          ciphertext,
          chainHash,
          unlockRound,
          requestedAt,
          roundTime,
          retryAt: roundTime,
        })
        .run();
    }
    tx.update(conversations)
      .set({
        updatedAt: sql`max(${conversations.updatedAt}, ${input.sentAt})`,
        unread: sql`${conversations.unread} + ${Number(isUnread)}`,
        deletedAt: null,
        ...(clearDraft ? { draft: "", draftReplyTo: null } : {}),
      })
      .where(eq(conversations.peerKey, input.peerKey))
      .run();
    return true;
  }

  function storeMessage(
    input: MessageInput,
    outgoing: boolean,
    clearDraft: boolean,
  ) {
    const inserted = db.transaction((tx) =>
      insertMessage(tx, input, outgoing, clearDraft),
    );
    if (inserted)
      changed({
        history: [input.peerKey],
        summaries: true,
        unread: input.direction === "incoming",
        unlockQueue: Boolean(input.timeLock),
      });
    return inserted;
  }

  const stillSealed = (item: PendingUnlock) =>
    and(
      eq(messageTimeLocks.messageId, item.messageId),
      eq(messageTimeLocks.ciphertext, item.content.ciphertext),
      eq(messageTimeLocks.unlockRound, item.content.unlockRound),
      eq(messageTimeLocks.chainHash, item.content.chainHash),
      isNull(messageTimeLocks.openedAt),
    );

  return {
    nextUnlock() {
      return (
        db
          .select({ retryAt: messageTimeLocks.retryAt })
          .from(messageTimeLocks)
          .innerJoin(messages, eq(messages.id, messageTimeLocks.messageId))
          .where(
            and(
              notBlocked(messages.peerKey),
              isNotNull(messageTimeLocks.retryAt),
              eq(messageTimeLocks.chainHash, quicknetHash),
            ),
          )
          .orderBy(asc(messageTimeLocks.retryAt))
          .limit(1)
          .get()?.retryAt ?? null
      );
    },

    dueUnlocks(now: number): PendingUnlock[] {
      return db
        .select({ lock: messageTimeLocks, peerKey: messages.peerKey })
        .from(messageTimeLocks)
        .innerJoin(messages, eq(messages.id, messageTimeLocks.messageId))
        .where(
          and(
            notBlocked(messages.peerKey),
            isNotNull(messageTimeLocks.retryAt),
            sql`${messageTimeLocks.retryAt} <= ${now}`,
            isNull(messages.deletedAt),
            eq(messageTimeLocks.chainHash, quicknetHash),
          ),
        )
        .orderBy(
          asc(messageTimeLocks.retryAt),
          asc(messageTimeLocks.unlockRound),
          asc(messageTimeLocks.messageId),
        )
        .limit(12)
        .all()
        .map(({ lock, peerKey }) => ({
          peerKey,
          messageId: lock.messageId,
          attempts: lock.attempts,
          content: {
            type: "timelock",
            v: 1,
            chainHash: quicknetHash,
            ciphertext: lock.ciphertext,
            unlockRound: lock.unlockRound,
            requestedAt: lock.requestedAt,
            roundTime: lock.roundTime,
          },
        }));
    },

    commitUnlock(item: PendingUnlock, body: string, now: number) {
      if (
        db
          .select({ key: blockedIdentities.publicKey })
          .from(blockedIdentities)
          .where(eq(blockedIdentities.publicKey, item.peerKey))
          .get()
      )
        return false;
      const updated = db.transaction((tx) => {
        const lock = tx
          .update(messageTimeLocks)
          .set({ openedAt: now, retryAt: null, error: null })
          .where(stillSealed(item))
          .returning({ id: messageTimeLocks.messageId })
          .get();
        if (!lock) return false;
        const row = tx
          .update(messages)
          .set({ body })
          .where(
            and(
              liveMessage(item.peerKey),
              eq(messages.id, lock.id),
              eq(messages.body, ""),
            ),
          )
          .returning({ id: messages.id })
          .get();
        if (!row) tx.rollback();
        return true;
      });
      if (updated) changed({ history: [item.peerKey], summaries: true });
    },

    deferUnlock(
      item: PendingUnlock,
      error: UnlockFailure,
      retryAt: number | null,
    ) {
      const row = db
        .update(messageTimeLocks)
        .set({ error, retryAt, attempts: Math.min(item.attempts + 1, 16) })
        .where(stillSealed(item))
        .returning({ id: messageTimeLocks.messageId })
        .get();
      if (row) changed({ history: [item.peerKey] });
    },

    resumeUnlocks(now: number) {
      db.update(messageTimeLocks)
        .set({ retryAt: now })
        .where(
          and(
            eq(messageTimeLocks.error, "network"),
            sql`${messageTimeLocks.roundTime} <= ${now}`,
            sql`${messageTimeLocks.retryAt} > ${now}`,
          ),
        )
        .run();
    },

    retryUnlock(peerKey: string, id: string, now: number) {
      const row = db
        .update(messageTimeLocks)
        .set({
          retryAt: sql`max(${messageTimeLocks.roundTime}, ${now})`,
        })
        .where(
          and(
            eq(messageTimeLocks.messageId, id),
            isNotNull(messageTimeLocks.retryAt),
            inArray(
              messageTimeLocks.messageId,
              db
                .select({ id: messages.id })
                .from(messages)
                .where(liveMessage(peerKey)),
            ),
          ),
        )
        .returning({ id: messageTimeLocks.messageId })
        .get();
      if (row) changed({ unlockQueue: true });
    },

    historyRevision: (peerKey: string) =>
      historyRevisions.get(peerKey) ?? resetRevision,
    invalidate: () =>
      changed({
        history: "all",
        summaries: true,
        unread: true,
        unlockQueue: true,
      }),
    subscribe(listener: (change: Change) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    unreadCount() {
      return (
        db
          .select({
            count: sql<number>`coalesce(sum(${conversations.unread}), 0)`,
          })
          .from(conversations)
          .where(
            and(
              notBlocked(conversations.peerKey),
              isNull(conversations.deletedAt),
              sql`${conversations.unread} > 0`,
            ),
          )
          .get()?.count ?? 0
      );
    },

    conversations(
      options: { archived?: boolean; translationTarget?: string } = {},
    ): ConversationSummary[] {
      return conversationQuery(db, options.translationTarget)
        .where(
          and(
            isNull(conversations.deletedAt),
            options.archived === undefined
              ? undefined
              : eq(conversations.archived, options.archived),
          ),
        )
        .orderBy(
          asc(sql`${conversations.pinnedRank} IS NULL`),
          asc(conversations.pinnedRank),
          desc(conversations.updatedAt),
          asc(conversations.peerKey),
        )
        .all();
    },

    conversation(peerKey: string): ConversationSummary | undefined {
      return conversationQuery(db)
        .where(
          and(
            eq(conversations.peerKey, peerKey),
            isNull(conversations.deletedAt),
          ),
        )
        .get();
    },

    draft(peerKey: string) {
      return db
        .select({
          draft: conversations.draft,
          draftReplyTo: conversations.draftReplyTo,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.peerKey, peerKey),
            isNull(conversations.deletedAt),
          ),
        )
        .get();
    },

    ensureConversation(peerKey: string) {
      const updated = db
        .insert(conversations)
        .values({ peerKey, updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: conversations.peerKey,
          set: { deletedAt: null, updatedAt: Date.now() },
          setWhere: isNotNull(conversations.deletedAt),
        })
        .returning({ peerKey: conversations.peerKey })
        .get();
      if (updated) changed({ summaries: true });
    },

    saveDraft(peerKey: string, draft: string, draftReplyTo: string | null) {
      const updated = db
        .insert(conversations)
        .values({ peerKey, updatedAt: Date.now(), draft, draftReplyTo })
        .onConflictDoUpdate({
          target: conversations.peerKey,
          set: { draft, draftReplyTo },
          setWhere: sql`(${conversations.draft}, ${conversations.draftReplyTo}) IS NOT (${draft}, ${draftReplyTo})
            AND ${conversations.deletedAt} IS NULL`,
        })
        .returning({ peerKey: conversations.peerKey })
        .get();
      if (updated) changed({ summaries: true });
    },

    history(peerKey: string, options: HistoryOptions = {}) {
      const limit = pageLimit(options.limit ?? 50);
      const { before, atOrBefore, after, atOrAfter } = options;
      const ascending = Boolean(after || atOrAfter);
      const existsPast = (edge: MessageCursor, sign: "<" | ">") =>
        Boolean(
          db
            .select({ id: messages.id })
            .from(messages)
            .where(and(liveMessage(peerKey), rowKey(edge, sign)))
            .get(),
        );
      const rows = db
        .select()
        .from(messages)
        .where(
          and(
            liveMessage(peerKey),
            before ? rowKey(before, "<") : undefined,
            atOrBefore ? rowKey(atOrBefore, "<=") : undefined,
            after ? rowKey(after, ">") : undefined,
            atOrAfter ? rowKey(atOrAfter, ">=") : undefined,
          ),
        )
        .orderBy(
          ascending ? asc(messages.sentAt) : desc(messages.sentAt),
          ascending ? asc(messages.id) : desc(messages.id),
        )
        .limit(limit + 1)
        .all();
      const more = rows.length > limit;
      if (more) rows.pop();
      if (!ascending) rows.reverse();
      const first = cursor(rows[0]);
      const last = cursor(rows.at(-1));
      return {
        messages: withReactions(peerKey, rows),
        older:
          first && (ascending ? existsPast(first, "<") : more) ? first : null,
        newer:
          last &&
          (ascending ? more : (before || atOrBefore) && existsPast(last, ">"))
            ? last
            : null,
      };
    },

    firstUnread(peerKey: string): MessageCursor | undefined {
      return db
        .select({ id: messages.id, sentAt: messages.sentAt })
        .from(messages)
        .where(and(liveMessage(peerKey), sql`${messages.isUnread} = 1`))
        .orderBy(asc(messages.sentAt), asc(messages.id))
        .get();
    },

    message(peerKey: string, reference: string): MessageRecord | undefined {
      const row = messageRow(peerKey, reference);
      return row ? withReactions(peerKey, [row])[0] : undefined;
    },

    refs(peerKey: string, references: readonly string[]) {
      const result = new Map<string, MessageRow>();
      const unique = [...new Set(references)];
      for (let start = 0; start < unique.length; start += 250) {
        const chunk = unique.slice(start, start + 250);
        const rows = db
          .select()
          .from(messages)
          .where(
            and(
              liveMessage(peerKey),
              or(inArray(messages.id, chunk), inArray(messages.eventId, chunk)),
            ),
          )
          .all();
        for (const row of rows) {
          result.set(row.id, row);
          if (row.eventId) result.set(row.eventId, row);
        }
      }
      return result;
    },

    markRead(peerKey: string, ids: readonly string[]) {
      if (!ids.length) return;
      const unique = [...new Set(ids)];
      const read = db.transaction((tx) => {
        let count = 0;
        for (let start = 0; start < unique.length; start += 200) {
          count += tx
            .update(messages)
            .set({ isUnread: false })
            .where(
              and(
                liveMessage(peerKey),
                sql`${messages.isUnread} = 1`,
                or(
                  eq(messages.contentType, "text"),
                  sql`${messages.body} <> ''`,
                ),
                inArray(messages.id, unique.slice(start, start + 200)),
              ),
            )
            .returning({ id: messages.id })
            .all().length;
        }
        if (!count) return false;
        tx.update(conversations)
          .set({ unread: sql`${conversations.unread} - ${count}` })
          .where(eq(conversations.peerKey, peerKey))
          .run();
        return true;
      });
      if (read) changed({ history: [peerKey], summaries: true, unread: true });
    },

    updateConversations(
      keys: readonly string[],
      patch: { pinned?: boolean; muted?: boolean; archived?: boolean },
    ) {
      const { pinned, muted, archived } = patch;
      if (
        keys.length === 0 ||
        (pinned === undefined && muted === undefined && archived === undefined)
      )
        return;
      db.transaction((tx) => {
        const max =
          tx
            .select({
              rank: sql<number>`coalesce(max(${conversations.pinnedRank}), -1)`,
            })
            .from(conversations)
            .get()?.rank ?? -1;
        let rank = max + 1;
        for (const key of new Set(keys)) {
          tx.update(conversations)
            .set({
              ...(pinned === undefined
                ? {}
                : {
                    pinnedRank: pinned
                      ? sql`coalesce(${conversations.pinnedRank}, ${rank++})`
                      : null,
                  }),
              ...(muted === undefined ? {} : { muted }),
              ...(archived === undefined ? {} : { archived }),
            })
            .where(
              and(
                eq(conversations.peerKey, key),
                isNull(conversations.deletedAt),
              ),
            )
            .run();
        }
      });
      changed({ summaries: true });
    },

    reorderPinned(keys: readonly string[]) {
      if (keys.length === 0) return;
      db.transaction((tx) => {
        // Only reorder the provided subset of pinned chats, such as the current archive view.
        const pinned = tx
          .select({
            peerKey: conversations.peerKey,
            rank: conversations.pinnedRank,
          })
          .from(conversations)
          .where(
            and(
              inArray(conversations.peerKey, [...new Set(keys)]),
              isNotNull(conversations.pinnedRank),
              isNull(conversations.deletedAt),
            ),
          )
          .orderBy(asc(conversations.pinnedRank), asc(conversations.peerKey))
          .all();
        const known = new Set(pinned.map(({ peerKey }) => peerKey));
        [...new Set(keys)]
          .filter((key) => known.has(key))
          .forEach((key, index) => {
            const slot = pinned[index]?.rank;
            if (slot == null) return;
            tx.update(conversations)
              .set({ pinnedRank: slot })
              .where(eq(conversations.peerKey, key))
              .run();
          });
      });
      changed({ summaries: true });
    },

    deleteConversations(keys: readonly string[]) {
      if (keys.length === 0) return;
      const peers = [...new Set(keys)];
      const deletedAt = Date.now();
      db.transaction((tx) => {
        tx.delete(messageTimeLocks)
          .where(
            inArray(
              messageTimeLocks.messageId,
              tx
                .select({ id: messages.id })
                .from(messages)
                .where(inArray(messages.peerKey, peers)),
            ),
          )
          .run();
        tx.update(messages)
          .set({
            deletedAt,
            body: "",
            rumorJson: null,
            failure: null,
            replyTo: null,
            isUnread: false,
          })
          .where(
            and(inArray(messages.peerKey, peers), isNull(messages.deletedAt)),
          )
          .run();
        tx.delete(messageReactions)
          .where(inArray(messageReactions.peerKey, peers))
          .run();
        tx.update(conversations)
          .set({
            deletedAt,
            unread: 0,
            draft: "",
            draftReplyTo: null,
            pinnedRank: null,
          })
          .where(inArray(conversations.peerKey, peers))
          .run();
      });
      changed({
        history: peers,
        summaries: true,
        unread: true,
        unlockQueue: true,
      });
    },

    deleteMessages(peerKey: string, ids: readonly string[]) {
      if (ids.length === 0) return;
      db.transaction((tx) => {
        const removed = tx
          .update(messages)
          .set({
            deletedAt: Date.now(),
            body: "",
            rumorJson: null,
            failure: null,
            replyTo: null,
            isUnread: false,
          })
          .where(
            and(liveMessage(peerKey), inArray(messages.id, [...new Set(ids)])),
          )
          .returning({ id: messages.id, eventId: messages.eventId })
          .all();
        if (removed.length === 0) return;
        tx.delete(messageTimeLocks)
          .where(
            inArray(
              messageTimeLocks.messageId,
              removed.map(({ id }) => id),
            ),
          )
          .run();
        tx.delete(messageReactions)
          .where(
            and(
              eq(messageReactions.peerKey, peerKey),
              inArray(
                messageReactions.targetId,
                removed.map((row) => row.eventId ?? row.id),
              ),
            ),
          )
          .run();
        recountUnread(tx, peerKey);
      });
      changed({
        history: [peerKey],
        summaries: true,
        unread: true,
        unlockQueue: true,
      });
    },

    toggleReaction(
      peerKey: string,
      reference: string,
      author: string,
      emoji: string,
    ) {
      const active = db.transaction((tx) => {
        const row = messageRow(peerKey, reference);
        if (!row) return undefined;
        const updated = tx
          .insert(messageReactions)
          .values({ peerKey, targetId: row.eventId ?? row.id, author, emoji })
          .onConflictDoUpdate({
            target: [
              messageReactions.peerKey,
              messageReactions.targetId,
              messageReactions.author,
              messageReactions.emoji,
            ],
            set: { removed: sql`NOT ${messageReactions.removed}` },
          })
          .returning({ removed: messageReactions.removed })
          .get();
        return updated ? !updated.removed : undefined;
      });
      if (active !== undefined) changed({ history: [peerKey] });
      return active ?? false;
    },

    receiveReaction(input: ReactionInput) {
      const inserted = db.transaction((tx) => {
        const target = tx
          .select({ deletedAt: messages.deletedAt })
          .from(messages)
          .where(
            and(
              eq(messages.peerKey, input.peerKey),
              eq(messages.eventId, input.targetEventId),
            ),
          )
          .get();
        if (target?.deletedAt) return false;
        ensureRoom(tx, input.peerKey, 0, 0);
        return Boolean(
          tx
            .insert(messageReactions)
            .values({
              peerKey: input.peerKey,
              targetId: input.targetEventId,
              author: input.author,
              emoji: input.emoji,
            })
            .onConflictDoNothing()
            .returning({ targetId: messageReactions.targetId })
            .get(),
        );
      });
      if (inserted) changed({ history: [input.peerKey] });
      return inserted;
    },

    receive(input: MessageInput) {
      return storeMessage(input, false, false);
    },

    acceptRequest(peerKey: string, inputs: MessageInput[]) {
      const inserted = db.transaction((tx) => {
        tx.insert(communicationGrants)
          .values({ publicKey: peerKey, approved: true })
          .onConflictDoUpdate({
            target: communicationGrants.publicKey,
            set: { approved: true },
          })
          .run();
        tx.delete(messageRequests)
          .where(eq(messageRequests.publicKey, peerKey))
          .run();
        return inputs.filter((input) => insertMessage(tx, input, false, false));
      });
      if (inserted.length)
        changed({
          history: [peerKey],
          summaries: true,
          unread: true,
          unlockQueue: inserted.some((input) => Boolean(input.timeLock)),
        });
    },

    enqueue(input: MessageInput, options: { clearDraft?: boolean } = {}) {
      return storeMessage(input, true, options.clearDraft ?? true);
    },

    pending(limit = 25) {
      return db
        .select()
        .from(messages)
        .where(
          and(sql`${messages.status} = 'pending'`, isNull(messages.deletedAt)),
        )
        .orderBy(asc(messages.sentAt), asc(messages.id))
        .limit(pageLimit(limit))
        .all();
    },

    setStatus(
      id: string,
      status: "pending" | "sent" | "failed",
      failure: string | null = null,
    ) {
      const updated = db
        .update(messages)
        .set({
          status,
          failure,
          ...(status === "sent" ? { rumorJson: null } : {}),
        })
        .where(
          and(
            eq(messages.id, id),
            isNull(messages.deletedAt),
            eq(messages.direction, "outgoing"),
            status === "pending"
              ? eq(messages.status, "failed")
              : inArray(messages.status, ["pending", "failed"]),
          ),
        )
        .returning({ peerKey: messages.peerKey })
        .get();
      if (updated) changed({ history: [updated.peerKey], summaries: true });
      return Boolean(updated);
    },
  };
}
