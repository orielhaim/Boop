import { and, eq, isNull, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { MessageInput } from "./messaging";
import * as schema from "./schema";

export const stressPeerKey =
  "bb2f67bc599b5adef13a861a8ef48dd32b4be1a7fabd6dfef4398524299d5434";
export const secondStressPeerKey =
  "8eedd66021b2588e04def955f54845f29010e6e84b94059ebc09f107f0203e6c";

const start = Date.UTC(2026, 10, 1);
const history = [
  "Meet you outside after the show.",
  "The trail takes about two hours. Bring water and a light layer. We can decide where to stop when we reach the ridge.",
  "First line.\nSecond line wraps into a few more words.\n\nLast paragraph, after an empty line.",
  "👋🏽✨",
  "נתראה אחר כך! אפשר להיפגש בתחנה בשעה 18:30.",
  "היי Maya, let's meet at שער בגין entrance B.",
  "Details at https://example.org/boop?route=trail",
  "This is a longer note about our plans for the afternoon. The small path starts behind the station and follows the stream until the stone bridge.\n\nIf it rains we can take the paved route through the neighborhood instead. The café should still be open when we get back.",
];

function fixtureId(peerKey: string, index: number) {
  const key = peerKey.startsWith("ffffffffffff")
    ? peerKey.slice(-12)
    : peerKey.slice(0, 12);
  return `chat-stress:${key}:${String(index).padStart(5, "0")}`;
}

export function stressArrival(localKey: string, at = Date.now()): MessageInput {
  return {
    id: `chat-stress-arrival:${at}`,
    eventId: null,
    peerKey: stressPeerKey,
    direction: "incoming",
    body: "הגיעה הודעה חדשה • A new local test message arrived.",
    sentAt: at,
    replyTo: null,
    senderKey: stressPeerKey,
    recipientKey: localKey,
  };
}

export function seedStressConversations<TResult>(
  db: BaseSQLiteDatabase<"sync", TResult, typeof schema>,
  localKey: string,
) {
  const { contacts, conversations, messages, messageReactions } = schema;
  const groups = [
    { peerKey: stressPeerKey, name: "Chat stress test", count: 10_000 },
    {
      peerKey: secondStressPeerKey,
      name: "Second test conversation",
      count: 24,
    },
    ...Array.from({ length: 98 }, (_, index) => ({
      peerKey: (index + 1).toString(16).padStart(64, "f"),
      name: `Test conversation ${index + 3}`,
      count: 18,
    })),
  ];

  db.transaction((tx) => {
    for (const [group, { peerKey, name, count }] of groups.entries()) {
      tx.insert(contacts)
        .values({ publicKey: peerKey, name })
        .onConflictDoNothing()
        .run();
      tx.insert(conversations)
        .values({
          peerKey,
          updatedAt: start,
          pinnedRank: group > 1 && group % 21 === 0 ? group : null,
          archived: group > 1 && group % 8 === 0,
          muted: group > 1 && group % 11 === 0,
        })
        .onConflictDoNothing()
        .run();
      for (let offset = 0; offset < count; offset += 64) {
        const rows: (typeof messages.$inferInsert)[] = [];
        const reactions: (typeof messageReactions.$inferInsert)[] = [];
        const end = Math.min(offset + 64, count);
        for (let index = offset; index < end; index++) {
          const outgoing = Math.floor(index / 3) % 2 === 0;
          const id = fixtureId(peerKey, index);
          const replyIndex =
            index === count - 1
              ? Math.floor(count / 4)
              : index > 7 && (index === count - 2 || index % 31 === 0)
                ? index - 5
                : null;
          rows.push({
            id,
            peerKey,
            direction: outgoing ? "outgoing" : "incoming",
            body: history[index % history.length] ?? "",
            sentAt: start + Math.floor(index / 2) * 75_000,
            replyTo:
              replyIndex === null ? null : fixtureId(peerKey, replyIndex),
            senderKey: outgoing ? localKey : peerKey,
            recipientKey: outgoing ? peerKey : localKey,
            status: outgoing ? "synced" : "received",
            isUnread: !outgoing && index >= count - 12,
          });
          if (index % 11 === 0 || index === count - 2) {
            reactions.push({
              peerKey,
              targetId: id,
              author: localKey,
              emoji: "❤️",
            });
            reactions.push({
              peerKey,
              targetId: id,
              author: peerKey,
              emoji: "👍",
            });
          }
        }
        tx.insert(messages).values(rows).onConflictDoNothing().run();
        if (reactions.length)
          tx.insert(messageReactions)
            .values(reactions)
            .onConflictDoNothing()
            .run();
      }
      const summary = tx
        .select({
          unread: sql<number>`coalesce(sum(${messages.isUnread}), 0)`,
          newest: sql<number>`coalesce(max(${messages.sentAt}), 0)`,
        })
        .from(messages)
        .where(and(eq(messages.peerKey, peerKey), isNull(messages.deletedAt)))
        .get();
      if (summary?.newest) {
        tx.update(conversations)
          .set({
            deletedAt: null,
            updatedAt: summary.newest,
            unread: summary.unread,
          })
          .where(eq(conversations.peerKey, peerKey))
          .run();
      }
    }
  });
  return {
    peerKey: stressPeerKey,
    secondPeerKey: secondStressPeerKey,
    count: 10_000,
  };
}
