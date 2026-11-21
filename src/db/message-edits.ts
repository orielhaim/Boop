import { isNotNull, and, desc, eq, lte, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { PrivateEvent } from "@/core/messaging/nip17";
import * as schema from "./schema";

const { messages, messageRevisions, pendingMessageEdits, peerPermissions } =
  schema;
type EditDatabase<TResult> = Pick<
  BaseSQLiteDatabase<"sync", TResult, typeof schema>,
  "select" | "insert" | "update" | "delete"
>;
type Original = typeof messages.$inferSelect;
type Pending = typeof pendingMessageEdits.$inferSelect;
export type VerifiedEdit = Extract<PrivateEvent, { type: "edit" }>;

function matches(original: Original, edit: Pending) {
  return (
    original.deletedAt === null &&
    original.contentType === "text" &&
    original.eventId === edit.targetId &&
    original.peerKey === edit.peerKey &&
    original.senderKey === edit.senderKey &&
    original.recipientKey === edit.recipientKey
  );
}

function apply<TResult>(
  db: EditDatabase<TResult>,
  original: Original,
  edit: Pending,
) {
  if (!matches(original, edit)) return "rejected";
  if (
    db
      .select({ id: messageRevisions.revisionId })
      .from(messageRevisions)
      .where(eq(messageRevisions.revisionId, edit.revisionId))
      .get()
  )
    return "duplicate";

  const parent =
    edit.previousRevisionId === edit.targetId
      ? { messageId: original.id, depth: 0, timestamp: original.sentAt }
      : db
          .select()
          .from(messageRevisions)
          .where(eq(messageRevisions.revisionId, edit.previousRevisionId))
          .get();
  if (!parent) {
    const otherOriginal = db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.eventId, edit.previousRevisionId))
      .get();
    return otherOriginal ? "rejected" : "unresolved";
  }
  if (parent.messageId !== original.id || edit.timestamp < parent.timestamp)
    return "rejected";

  if (!original.revisionId) {
    db.insert(messageRevisions)
      .values({
        messageId: original.id,
        revisionId: edit.targetId,
        previousRevisionId: null,
        body: original.body,
        timestamp: original.sentAt,
        depth: 0,
      })
      .onConflictDoNothing()
      .run();
  }
  db.insert(messageRevisions)
    .values({
      messageId: original.id,
      revisionId: edit.revisionId,
      previousRevisionId: edit.previousRevisionId,
      body: edit.body,
      timestamp: edit.timestamp,
      depth: parent.depth + 1,
    })
    .run();
  return "applied";
}

function reconcile<TResult>(
  db: EditDatabase<TResult>,
  original: Original,
  roots: string[],
) {
  if (!original.eventId) return false;
  const now = Date.now();
  let applied = false;
  for (const predecessor of roots) {
    const children = db
      .select()
      .from(pendingMessageEdits)
      .where(
        and(
          eq(pendingMessageEdits.targetId, original.eventId),
          eq(pendingMessageEdits.previousRevisionId, predecessor),
        ),
      )
      .all();
    for (const child of children) {
      const result =
        child.expiresAt > now ? apply(db, original, child) : "rejected";
      if (result === "applied") {
        applied = true;
        roots.push(child.revisionId);
      }
      db.delete(pendingMessageEdits)
        .where(eq(pendingMessageEdits.revisionId, child.revisionId))
        .run();
    }
  }
  return applied;
}

function showWinner<TResult>(db: EditDatabase<TResult>, original: Original) {
  const winner = db
    .select()
    .from(messageRevisions)
    .where(eq(messageRevisions.messageId, original.id))
    .orderBy(
      desc(messageRevisions.depth),
      desc(messageRevisions.timestamp),
      desc(messageRevisions.revisionId),
    )
    .limit(1)
    .get();
  if (winner && winner.revisionId !== original.revisionId) {
    db.update(messages)
      .set({
        body: winner.body,
        editedAt: winner.timestamp,
        revisionId: winner.revisionId,
      })
      .where(eq(messages.id, original.id))
      .run();
  }
}

function blocked<TResult>(db: EditDatabase<TResult>, peer: string) {
  return db
    .select({ key: peerPermissions.publicKey })
    .from(peerPermissions)
    .where(
      and(
        eq(peerPermissions.publicKey, peer),
        isNotNull(peerPermissions.blockedAt),
      ),
    )
    .get();
}

export function reconcileOriginal<TResult>(
  db: EditDatabase<TResult>,
  original: Original,
) {
  if (!original.eventId || blocked(db, original.peerKey)) return;
  if (reconcile(db, original, [original.eventId])) showWinner(db, original);
}

export function storeVerifiedEdit<TResult>(
  db: EditDatabase<TResult>,
  event: VerifiedEdit,
) {
  if (blocked(db, event.peerKey)) return "rejected";
  const original = db
    .select()
    .from(messages)
    .where(eq(messages.eventId, event.edit.targetId))
    .get();
  const now = Date.now();
  const edit: Pending = {
    revisionId: event.id,
    targetId: event.edit.targetId,
    previousRevisionId: event.edit.previousRevisionId,
    senderKey: event.senderKey,
    recipientKey: event.recipientKey,
    peerKey: event.peerKey,
    body: event.edit.text,
    timestamp: event.sentAt,
    expiresAt: now + 30 * 24 * 60 * 60_000,
  };
  const result = original ? apply(db, original, edit) : "unresolved";
  if (result === "unresolved") {
    db.delete(pendingMessageEdits)
      .where(lte(pendingMessageEdits.expiresAt, now))
      .run();
    const count = db
      .select({
        total: sql<number>`count(*)`,
        peer: sql<number>`count(*) FILTER (WHERE ${pendingMessageEdits.peerKey} = ${edit.peerKey})`,
      })
      .from(pendingMessageEdits)
      .get();
    if (!count || count.total >= 1_024 || count.peer >= 64) return "rejected";
    const inserted = db
      .insert(pendingMessageEdits)
      .values(edit)
      .onConflictDoNothing()
      .returning({ id: pendingMessageEdits.revisionId })
      .get();
    return inserted ? "unresolved" : "duplicate";
  } else if (original && result === "applied") {
    reconcile(db, original, [edit.revisionId]);
    showWinner(db, original);
  }
  return result;
}
