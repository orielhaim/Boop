import { voiceMetadata } from "@/core/media/protocol";
import type {
  AttachmentMetadata,
  SealedAttachment,
  VoiceMetadata,
} from "@/core/media/protocol";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
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
import {
  reconcileOriginal,
  storeVerifiedEdit,
  type VerifiedEdit,
} from "./message-edits";

const {
  messages,
  conversations,
  contacts,
  messageReactions,
  messageTimeLocks,
  messageAttachments,
  peerPermissions,
  messageRequests,
  messageRevisions,
  pendingMessageEdits,
  messageEditOutbox,
} = schema;
const notBlocked = (
  key: typeof messages.peerKey | typeof conversations.peerKey,
) =>
  sql`NOT EXISTS (SELECT 1 FROM ${peerPermissions} WHERE ${peerPermissions.publicKey} = ${key} AND ${peerPermissions.blockedAt} IS NOT NULL)`;
type MessageRow = typeof messages.$inferSelect;
const { rumorJson: _outboxPayload, ...visibleMessageColumns } =
  getTableColumns(messages);
type VisibleMessage = Omit<MessageRow, "rumorJson">;
const unreadMessage = sql`${messages.isUnread} = 1 AND ${messages.deletedAt} IS NULL`;
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
export type MessageRecord = VisibleMessage & {
  reactions: Reaction[];
  isPinned?: boolean;
  locked?: LockedPresentation;
  voice?: VoiceMetadata & { listened: boolean };
  media?: AttachmentMetadata & { size?: number; listened: boolean };
  editStatus?: typeof messageEditOutbox.$inferSelect.status;
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
  location?: true;
  attachment?: SealedAttachment & { url?: string };
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
          AND ${cached.sourceLanguage} <> ${target} AND trim(${cached.translatedText}) <> '')`
    : sql<string | null>`NULL`;
  const lastId = sql`(
    SELECT ${messages.id} FROM ${messages}
    WHERE ${messages.peerKey} = ${conversations.peerKey} AND ${messages.deletedAt} IS NULL
    ORDER BY ${messages.sentAt} DESC, ${messages.id} DESC LIMIT 1
  )`;
  return db
    .select({
      ...getTableColumns(conversations),
      unread: sql<number>`CASE WHEN ${notBlocked(conversations.peerKey)} THEN (SELECT count(*) FROM ${messages} WHERE ${messages.peerKey} = ${conversations.peerKey} AND ${unreadMessage}) ELSE 0 END`,
      name: contacts.name,
      preview: latest.body,
      lockedUntil: messageTimeLocks.requestedAt,
      voiceDuration: sql<
        number | null
      >`json_extract(${messageAttachments.file}, '$.durationMs')`,
      mediaKind: sql<
        AttachmentMetadata["kind"] | null
      >`json_extract(${messageAttachments.file}, '$.kind')`,
      lastMessageType: latest.contentType,
      translatedPreview,
      lastMessageAt: latest.sentAt,
      lastMessageId: latest.id,
      lastMessageDirection: latest.direction,
      lastMessageStatus: latest.status,
    })
    .from(conversations)
    .leftJoin(contacts, eq(conversations.peerKey, contacts.publicKey))
    .leftJoin(latest, eq(latest.id, lastId))
    .leftJoin(messageAttachments, eq(messageAttachments.messageId, latest.id))
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

function cursor(row: MessageCursor | undefined): MessageCursor | null {
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

  function hydrateMessages(
    peerKey: string,
    rows: VisibleMessage[],
  ): MessageRecord[] {
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
    const fileIds = rows
      .filter((row) => row.contentType === "attachment")
      .map((row) => row.id);
    const attachments = fileIds.length
      ? db
          .select()
          .from(messageAttachments)
          .where(inArray(messageAttachments.messageId, fileIds))
          .all()
      : [];
    const mediaById = new Map(
      attachments.map(({ messageId, file, listened }) => [
        messageId,
        {
          kind: file.kind,
          mime: file.mime,
          durationMs: file.durationMs,
          waveform: file.waveform,
          filename: file.filename,
          dimensions: file.dimensions,
          thumbhash: file.thumbhash,
          blurhash: file.blurhash,
          size: file.size,
          listened,
        },
      ]),
    );
    const outgoingTextIds = rows
      .filter(
        (row) => row.direction === "outgoing" && row.contentType === "text",
      )
      .map(({ id }) => id);
    const edits = outgoingTextIds.length
      ? db
          .select({
            id: messageEditOutbox.messageId,
            status: messageEditOutbox.status,
          })
          .from(messageEditOutbox)
          .where(inArray(messageEditOutbox.messageId, outgoingTextIds))
          .orderBy(
            sql`CASE ${messageEditOutbox.status} WHEN 'pending' THEN 4 WHEN 'failed' THEN 3 WHEN 'copy-failed' THEN 2 ELSE 1 END`,
          )
          .all()
      : [];
    const editStatuses = new Map(edits.map(({ id, status }) => [id, status]));
    return rows.map((row) => {
      const media = mediaById.get(row.id);
      const checkedVoice =
        media?.kind === "voice"
          ? voiceMetadata.safeParse(media).data
          : undefined;
      return {
        voice:
          checkedVoice && media
            ? { ...checkedVoice, listened: media.listened }
            : undefined,
        media,
        locked: locks.get(row.id),
        ...row,
        editStatus: editStatuses.get(row.id),
        isPinned: row.pinnedAt !== null,
        reactions: grouped.get(row.eventId ?? row.id) ?? [],
      };
    });
  }

  function messageRow(peerKey: string, reference: string) {
    return db
      .select(visibleMessageColumns)
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
    const { timeLock, attachment, location, ...record } = input;
    ensureRoom(tx, input.peerKey, input.sentAt);
    const isUnread = input.direction === "incoming";
    const stored = tx
      .insert(messages)
      .values({
        ...record,
        contentType: attachment
          ? "attachment"
          : timeLock
            ? "timelock"
            : location
              ? "location"
              : "text",
        body: timeLock ? "" : record.body,
        status: outgoing ? "pending" : isUnread ? "received" : "synced",
        isUnread,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    // A duplicate sender copy says nothing about acceptance by the recipient's relays.
    if (!stored) return false;
    if (attachment) {
      const { url, hash, ...file } = attachment;
      tx.insert(messageAttachments)
        .values({ messageId: stored.id, hash, file, url })
        .run();
    }
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
    reconcileOriginal(tx, stored);
    tx.update(conversations)
      .set({
        updatedAt: sql`max(${conversations.updatedAt}, ${input.sentAt})`,
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
    receiveEdit(event: VerifiedEdit) {
      const result = db.transaction((tx) => storeVerifiedEdit(tx, event));
      if (result === "applied" || result === "unresolved")
        changed({ history: [event.peerKey], summaries: result === "applied" });
      return result;
    },

    revisions(peerKey: string, id: string) {
      const original = messageRow(peerKey, id);
      if (!original?.revisionId || !original.eventId) return null;
      const versions = db
        .select()
        .from(messageRevisions)
        .where(eq(messageRevisions.messageId, original.id))
        .orderBy(
          asc(messageRevisions.timestamp),
          asc(messageRevisions.depth),
          asc(messageRevisions.revisionId),
        )
        .all();
      const unresolved = db
        .select({ id: pendingMessageEdits.revisionId })
        .from(pendingMessageEdits)
        .where(
          and(
            eq(pendingMessageEdits.targetId, original.eventId),
            eq(pendingMessageEdits.peerKey, peerKey),
            eq(pendingMessageEdits.senderKey, original.senderKey ?? ""),
            eq(pendingMessageEdits.recipientKey, original.recipientKey ?? ""),
            sql`${pendingMessageEdits.expiresAt} > ${Date.now()}`,
          ),
        )
        .get();
      return {
        versions,
        current: original.revisionId,
        direction: original.direction,
        incomplete:
          !!unresolved || versions[0]?.revisionId !== original.eventId,
      };
    },

    enqueueEdit(messageId: string, event: VerifiedEdit, rumorJson: string) {
      const inserted = db.transaction((tx) => {
        const original = messageRow(event.peerKey, messageId);
        if (
          !original ||
          original.eventId !== event.edit.targetId ||
          original.direction !== "outgoing" ||
          !["sent", "synced"].includes(original.status) ||
          original.contentType !== "text" ||
          original.senderKey !== event.senderKey ||
          original.recipientKey !== event.recipientKey ||
          (original.revisionId ?? original.eventId) !==
            event.edit.previousRevisionId ||
          original.body.trim() === event.edit.text
        )
          return false;
        return !!tx
          .insert(messageEditOutbox)
          .values({
            messageId,
            revisionId: event.id,
            rumorJson,
            status: "pending",
          })
          .onConflictDoNothing()
          .returning({ id: messageEditOutbox.revisionId })
          .get();
      });
      if (inserted) changed({ history: [event.peerKey] });
      return inserted;
    },

    editOutbox(copies: boolean) {
      return db
        .select({
          ...getTableColumns(messageEditOutbox),
          peerKey: messages.peerKey,
        })
        .from(messageEditOutbox)
        .innerJoin(messages, eq(messages.id, messageEditOutbox.messageId))
        .where(
          and(
            isNull(messages.deletedAt),
            copies
              ? inArray(messageEditOutbox.status, [
                  "copy-pending",
                  "copy-failed",
                ])
              : eq(messageEditOutbox.status, "pending"),
          ),
        )
        .orderBy(asc(messageEditOutbox.revisionId))
        .all();
    },

    finishEditDelivery(event: VerifiedEdit) {
      const committed = db.transaction((tx) => {
        const pending = tx
          .select({ id: messageEditOutbox.revisionId })
          .from(messageEditOutbox)
          .where(
            and(
              eq(messageEditOutbox.revisionId, event.id),
              eq(messageEditOutbox.status, "pending"),
            ),
          )
          .get();
        if (!pending) return false;
        const result = storeVerifiedEdit(tx, event);
        if (result !== "applied" && result !== "duplicate") return false;
        tx.update(messageEditOutbox)
          .set({ status: "copy-pending", failure: null })
          .where(eq(messageEditOutbox.revisionId, event.id))
          .run();
        return true;
      });
      if (committed) changed({ history: [event.peerKey], summaries: true });
      return committed;
    },

    finishEditCopy(peerKey: string, revisionId: string, success: boolean) {
      const filter = and(
        eq(messageEditOutbox.revisionId, revisionId),
        inArray(messageEditOutbox.status, ["copy-pending", "copy-failed"]),
      );
      const updated = success
        ? db
            .delete(messageEditOutbox)
            .where(filter)
            .returning({ id: messageEditOutbox.revisionId })
            .get()
        : db
            .update(messageEditOutbox)
            .set({ status: "copy-failed", failure: "relay-rejected" })
            .where(filter)
            .returning({ id: messageEditOutbox.revisionId })
            .get();
      if (updated) changed({ history: [peerKey] });
    },

    failEdit(peerKey: string, revisionId: string, failure: string) {
      const updated = db
        .update(messageEditOutbox)
        .set({ status: "failed", failure })
        .where(
          and(
            eq(messageEditOutbox.revisionId, revisionId),
            eq(messageEditOutbox.status, "pending"),
          ),
        )
        .returning({ id: messageEditOutbox.revisionId })
        .get();
      if (updated) changed({ history: [peerKey] });
    },

    retryEdit(peerKey: string, id: string) {
      if (!messageRow(peerKey, id)) return;
      db.update(messageEditOutbox)
        .set({
          status: sql`CASE ${messageEditOutbox.status} WHEN 'failed' THEN 'pending' ELSE 'copy-pending' END`,
          failure: null,
        })
        .where(
          and(
            eq(messageEditOutbox.messageId, id),
            inArray(messageEditOutbox.status, ["failed", "copy-failed"]),
          ),
        )
        .run();
      changed({ history: [peerKey] });
    },
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
          .select({ key: peerPermissions.publicKey })
          .from(peerPermissions)
          .where(
            and(
              eq(peerPermissions.publicKey, item.peerKey),
              isNotNull(peerPermissions.blockedAt),
            ),
          )
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
            count: sql<number>`count(*)`,
          })
          .from(messages)
          .where(
            and(
              unreadMessage,
              sql`${messages.peerKey} NOT IN (
                SELECT ${peerPermissions.publicKey} FROM ${peerPermissions}
                WHERE ${peerPermissions.blockedAt} IS NOT NULL
              )`,
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
        .select(visibleMessageColumns)
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
        messages: hydrateMessages(peerKey, rows),
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
      return row ? hydrateMessages(peerKey, [row])[0] : undefined;
    },

    refs(peerKey: string, references: readonly string[]) {
      const result = new Map<
        string,
        VisibleMessage & { quotedKind: AttachmentMetadata["kind"] | null }
      >();
      const unique = [...new Set(references)];
      for (let start = 0; start < unique.length; start += 250) {
        const chunk = unique.slice(start, start + 250);
        const rows = db
          .select({
            ...visibleMessageColumns,
            quotedKind: sql<
              AttachmentMetadata["kind"] | null
            >`json_extract(${messageAttachments.file}, '$.kind')`,
          })
          .from(messages)
          .leftJoin(
            messageAttachments,
            eq(messageAttachments.messageId, messages.id),
          )
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
                  ne(messages.contentType, "timelock"),
                  sql`${messages.body} <> ''`,
                ),
                inArray(messages.id, unique.slice(start, start + 200)),
              ),
            )
            .returning({ id: messages.id })
            .all().length;
        }
        return count > 0;
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

    pinnedMessages(peerKey: string) {
      return db
        .select({
          id: messages.id,
          sentAt: messages.sentAt,
          body: messages.body,
          contentType: messages.contentType,
          deletedAt: messages.deletedAt,
          direction: messages.direction,
          quotedKind: sql<
            AttachmentMetadata["kind"] | null
          >`json_extract(${messageAttachments.file}, '$.kind')`,
        })
        .from(messages)
        .leftJoin(
          messageAttachments,
          eq(messages.id, messageAttachments.messageId),
        )
        .where(and(liveMessage(peerKey), isNotNull(messages.pinnedAt)))
        .orderBy(desc(messages.pinnedAt), desc(messages.id))
        .all();
    },

    toggleMessagePin(peerKey: string, reference: string) {
      const row = messageRow(peerKey, reference);
      if (!row) return;
      db.update(messages)
        .set({ pinnedAt: row.pinnedAt === null ? Date.now() : null })
        .where(eq(messages.id, row.id))
        .run();
      changed({ history: [peerKey] });
    },

    hasMessages(peerKey: string) {
      return Boolean(
        db
          .select({ id: messages.id })
          .from(messages)
          .where(liveMessage(peerKey))
          .limit(1)
          .get(),
      );
    },

    previewMessage(peerKey: string, id: string) {
      return db
        .select({ body: messages.body, direction: messages.direction })
        .from(messages)
        .where(
          and(
            liveMessage(peerKey),
            eq(messages.id, id),
            inArray(messages.contentType, ["text", "timelock"]),
            ne(messages.body, ""),
          ),
        )
        .get();
    },

    deleteConversations(keys: readonly string[]) {
      if (keys.length === 0) return;
      const peers = [...new Set(keys)];
      const deletedAt = Date.now();
      db.transaction((tx) => {
        tx.delete(pendingMessageEdits)
          .where(inArray(pendingMessageEdits.peerKey, peers))
          .run();
        tx.update(messages)
          .set({
            deletedAt,
            body: "",
            rumorJson: null,
            failure: null,
            replyTo: null,
            pinnedAt: null,
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
            pinnedAt: null,
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

    attachment(peerKey: string, id: string) {
      const stored = db
        .select({
          ...getTableColumns(messageAttachments),
          direction: messages.direction,
          status: messages.status,
        })
        .from(messageAttachments)
        .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
        .where(
          and(
            liveMessage(peerKey),
            eq(messages.contentType, "attachment"),
            or(eq(messages.id, id), eq(messages.eventId, id)),
          ),
        )
        .get();
      if (stored) {
        const { hash, file, ...attachment } = stored;
        return { ...attachment, file: { ...file, hash }, peerKey };
      }
    },

    hasAttachment(hash: string, pendingOnly = false) {
      return Boolean(
        db
          .select({ id: messages.id })
          .from(messageAttachments)
          .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
          .where(
            and(
              isNull(messages.deletedAt),
              pendingOnly
                ? inArray(messages.status, ["pending", "failed"])
                : undefined,
              eq(messageAttachments.hash, hash),
            ),
          )
          .get(),
      );
    },

    markListened(peerKey: string, id: string) {
      const row = messageRow(peerKey, id);
      if (row?.direction !== "incoming") return;
      const updated = db
        .update(messageAttachments)
        .set({ listened: true })
        .where(
          and(
            eq(messageAttachments.messageId, row.id),
            eq(messageAttachments.listened, false),
          ),
        )
        .returning({ id: messageAttachments.messageId })
        .get();
      if (updated) changed({ history: [peerKey] });
    },

    finalizeAttachment(
      peerKey: string,
      id: string,
      eventId: string,
      url: string,
      rumorJson: string,
    ) {
      const committed = db.transaction((tx) => {
        const updated = tx
          .update(messages)
          .set({ eventId, rumorJson })
          .where(
            and(
              liveMessage(peerKey),
              eq(messages.id, id),
              eq(messages.status, "pending"),
              eq(messages.contentType, "attachment"),
              isNull(messages.eventId),
            ),
          )
          .returning({ id: messages.id })
          .get();
        if (!updated) return false;
        tx.update(messageAttachments)
          .set({ url })
          .where(eq(messageAttachments.messageId, id))
          .run();
        return true;
      });
      if (committed) changed({ history: [peerKey] });
      return committed;
    },

    receive(input: MessageInput) {
      return storeMessage(input, false, false);
    },

    acceptRequest(peerKey: string, inputs: MessageInput[]) {
      const inserted = db.transaction((tx) => {
        tx.insert(peerPermissions)
          .values({ publicKey: peerKey, approved: true })
          .onConflictDoUpdate({
            target: peerPermissions.publicKey,
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

    pendingAttachmentCopies() {
      return db
        .select()
        .from(messages)
        .where(
          and(
            sql`${messages.status} = 'sent' AND ${messages.contentType} = 'attachment'`,
            isNotNull(messages.rumorJson),
            isNull(messages.deletedAt),
          ),
        )
        .orderBy(asc(messages.sentAt), asc(messages.id))
        .limit(16)
        .all();
    },

    finishAttachmentCopy(id: string) {
      db.update(messages)
        .set({ rumorJson: null })
        .where(
          and(
            eq(messages.id, id),
            eq(messages.status, "sent"),
            eq(messages.contentType, "attachment"),
          ),
        )
        .run();
    },

    pending(limit = 25, includeAttachments = true) {
      return db
        .select()
        .from(messages)
        .where(
          and(
            sql`${messages.status} = 'pending'`,
            isNull(messages.deletedAt),
            includeAttachments
              ? undefined
              : sql`${messages.contentType} <> 'attachment'`,
          ),
        )
        .orderBy(asc(messages.sentAt), asc(messages.id))
        .limit(pageLimit(limit))
        .all();
    },

    setStatus(
      id: string,
      status: "pending" | "sent" | "failed",
      failure: string | null = null,
      peerKey?: string,
    ) {
      const updated = db
        .update(messages)
        .set({
          status,
          failure,
          ...(status === "sent"
            ? {
                rumorJson: sql`CASE WHEN ${messages.contentType} = 'attachment' THEN ${messages.rumorJson} ELSE NULL END`,
              }
            : {}),
        })
        .where(
          and(
            eq(messages.id, id),
            isNull(messages.deletedAt),
            eq(messages.direction, "outgoing"),
            peerKey === undefined ? undefined : eq(messages.peerKey, peerKey),
            status === "pending"
              ? and(
                  eq(messages.status, "failed"),
                  or(
                    isNotNull(messages.rumorJson),
                    eq(messages.contentType, "attachment"),
                  ),
                )
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
