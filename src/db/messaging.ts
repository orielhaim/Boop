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
import * as schema from "./schema";

const { messages, conversations, contacts, messageReactions } = schema;
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
export type MessageRecord = MessageRow & { reactions: Reaction[] };
export type MessageInput = Pick<
  MessageRow,
  "id" | "eventId" | "peerKey" | "direction" | "body" | "sentAt" | "replyTo"
> & { senderKey: string; recipientKey: string; rumorJson?: string };
type ReactionInput = Reaction & {
  eventId: string;
  peerKey: string;
  targetEventId: string;
};
type HistoryOptions = {
  before?: MessageCursor;
  atOrBefore?: MessageCursor;
  atOrAfter?: MessageCursor;
  after?: MessageCursor;
  limit?: number;
};

function conversationQuery<TResult>(db: ReadDatabase<TResult>) {
  const latest = alias(messages, "latest_message");
  const lastId = sql`(
    SELECT ${messages.id} FROM ${messages}
    WHERE ${messages.peerKey} = ${conversations.peerKey} AND ${messages.deletedAt} IS NULL
    ORDER BY ${messages.sentAt} DESC, ${messages.id} DESC LIMIT 1
  )`;
  return db
    .select({
      ...getTableColumns(conversations),
      name: contacts.name,
      avatarUrl: contacts.avatarUrl,
      preview: latest.body,
      lastMessageAt: latest.sentAt,
      lastMessageId: latest.id,
      lastMessageDirection: latest.direction,
      lastMessageStatus: latest.status,
    })
    .from(conversations)
    .leftJoin(contacts, eq(conversations.peerKey, contacts.publicKey))
    .leftJoin(latest, eq(latest.id, lastId));
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

const pageLimit = (limit: number) =>
  Math.max(1, Math.min(200, Math.floor(limit) || 1));

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

export function createMessagingRepository<TResult>(
  db: BaseSQLiteDatabase<"sync", TResult, typeof schema>,
) {
  let revision = 0;
  const listeners = new Set<() => void>();

  function changed() {
    revision++;
    for (const listener of listeners) listener();
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
    return rows.map((row) => ({
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

  function storeMessage(
    input: MessageInput,
    outgoing: boolean,
    clearDraft: boolean,
  ) {
    const inserted = db.transaction((tx) => {
      ensureRoom(tx, input.peerKey, input.sentAt);
      const isUnread = input.direction === "incoming";
      const stored = tx
        .insert(messages)
        .values({
          ...input,
          status: outgoing ? "pending" : isUnread ? "received" : "synced",
          isUnread,
        })
        .onConflictDoNothing()
        .returning({ id: messages.id })
        .get();
      // A duplicate sender copy says nothing about acceptance by the recipient's relays.
      if (!stored) return false;
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
    });
    if (inserted) changed();
    return inserted;
  }

  return {
    getRevision: () => revision,
    invalidate: changed,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    conversations(options: { archived?: boolean } = {}): ConversationSummary[] {
      return conversationQuery(db)
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
      if (updated) changed();
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
      if (updated) changed();
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
      const firstUnreadMessageId =
        db
          .select({ id: messages.id })
          .from(messages)
          .where(and(liveMessage(peerKey), sql`${messages.isUnread} = 1`))
          .orderBy(asc(messages.sentAt), asc(messages.id))
          .get()?.id ?? null;
      return {
        messages: withReactions(peerKey, rows),
        older:
          first && (ascending ? existsPast(first, "<") : more) ? first : null,
        newer:
          last &&
          (ascending ? more : (before || atOrBefore) && existsPast(last, ">"))
            ? last
            : null,
        firstUnreadMessageId,
      };
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

    markRead(peerKey: string, through?: MessageCursor) {
      const read = db.transaction((tx) => {
        const unread = and(
          liveMessage(peerKey),
          sql`${messages.isUnread} = 1`,
          through ? rowKey(through, "<=") : undefined,
        );
        if (!tx.select({ id: messages.id }).from(messages).where(unread).get())
          return false;
        tx.update(messages).set({ isUnread: false }).where(unread).run();
        recountUnread(tx, peerKey);
        return true;
      });
      if (read) changed();
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
      changed();
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
      changed();
    },

    deleteConversations(keys: readonly string[]) {
      if (keys.length === 0) return;
      const peers = [...new Set(keys)];
      const deletedAt = Date.now();
      db.transaction((tx) => {
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
      changed();
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
      changed();
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
      if (active !== undefined) changed();
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
      if (inserted) changed();
      return inserted;
    },

    receive(input: MessageInput) {
      return storeMessage(input, false, false);
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
        .returning({ id: messages.id })
        .get();
      if (updated) changed();
      return Boolean(updated);
    },
  };
}
