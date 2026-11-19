import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const contacts = sqliteTable("contacts", {
  publicKey: text("public_key").primaryKey().notNull(),
  name: text().notNull(),
  avatarUrl: text("avatar_url"),
  favorite: integer({ mode: "boolean" }).notNull().default(false),
  allowIncomingVideo: integer("allow_incoming_video", { mode: "boolean" })
    .notNull()
    .default(false),
});

export const conversations = sqliteTable(
  "conversations",
  {
    peerKey: text("peer_key").primaryKey().notNull(),
    updatedAt: integer("updated_at").notNull(),
    unread: integer().notNull().default(0),
    draft: text().notNull().default(""),
    draftReplyTo: text("draft_reply_to"),
    pinnedRank: integer("pinned_rank"),
    muted: integer({ mode: "boolean" }).notNull().default(false),
    archived: integer({ mode: "boolean" }).notNull().default(false),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("conversations_order")
      .on(
        sql`${table.pinnedRank} IS NULL`,
        table.pinnedRank,
        sql`${table.updatedAt} DESC`,
        table.peerKey,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    index("conversations_unread")
      .on(table.unread)
      .where(sql`${table.deletedAt} IS NULL AND ${table.unread} > 0`),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text().primaryKey().notNull(),
    eventId: text("event_id").unique(),
    peerKey: text("peer_key")
      .notNull()
      .references(() => conversations.peerKey),
    direction: text({ enum: ["incoming", "outgoing"] }).notNull(),
    body: text().notNull(),
    sentAt: integer("sent_at").notNull(),
    replyTo: text("reply_to"),
    senderKey: text("sender_key"),
    recipientKey: text("recipient_key"),
    status: text({ enum: ["received", "synced", "pending", "sent", "failed"] })
      .notNull()
      .default("received"),
    failure: text(),
    deletedAt: integer("deleted_at"),
    isUnread: integer("is_unread", { mode: "boolean" })
      .notNull()
      .default(false),
    rumorJson: text("rumor_json"),
    contentType: text("content_type", { enum: ["text", "timelock"] })
      .notNull()
      .default("text"),
  },
  (table) => [
    index("messages_peer_order")
      .on(table.peerKey, table.sentAt, table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    index("messages_unread")
      .on(table.peerKey, table.sentAt, table.id)
      .where(sql`${table.isUnread} = 1 AND ${table.deletedAt} IS NULL`),
    index("messages_outbox")
      .on(table.sentAt, table.id)
      .where(sql`${table.status} = 'pending' AND ${table.deletedAt} IS NULL`),
  ],
);

export const messageTimeLocks = sqliteTable(
  "message_timelocks",
  {
    messageId: text("message_id")
      .primaryKey()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    ciphertext: text().notNull(),
    chainHash: text("chain_hash").notNull(),
    unlockRound: integer("unlock_round").notNull(),
    requestedAt: integer("requested_at").notNull(),
    roundTime: integer("round_time").notNull(),
    openedAt: integer("opened_at"),
    retryAt: integer("retry_at"),
    attempts: integer().notNull().default(0),
    error: text({
      enum: [
        "not-ready",
        "network",
        "endpoint",
        "verification",
        "ciphertext",
        "decryption",
        "plaintext",
      ],
    }),
  },
  (table) => [
    index("message_timelocks_pending")
      .on(table.retryAt, table.unlockRound, table.messageId)
      .where(sql`${table.retryAt} IS NOT NULL`),
  ],
);

export const messageTranslations = sqliteTable(
  "message_translations",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    targetLanguage: text("target_language").notNull(),
    sourceLanguage: text("source_language").notNull(),
    translatedText: text("translated_text").notNull(),
    engine: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.messageId, table.targetLanguage, table.contentHash],
    }),
  ],
);

export const messageReactions = sqliteTable(
  "message_reactions",
  {
    peerKey: text("peer_key")
      .notNull()
      .references(() => conversations.peerKey),
    targetId: text("target_id").notNull(),
    author: text().notNull(),
    emoji: text().notNull(),
    removed: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    primaryKey({
      columns: [table.peerKey, table.targetId, table.author, table.emoji],
    }),
  ],
);

export const callHistory = sqliteTable("call_history", {
  id: text().primaryKey().notNull(),
  peerKey: text("peer_key").notNull(),
  participantKeys: text("participant_keys", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  invitationIds: text("invitation_ids", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  direction: text({ enum: ["incoming", "outgoing"] }).notNull(),
  outcome: text({
    enum: [
      "answered",
      "completed",
      "missed",
      "rejected",
      "failed",
      "cancelled",
      "busy",
      "unanswered",
      "remote-disconnected",
    ],
  }).notNull(),
  startedAt: integer("started_at").notNull(),
  answeredAt: integer("answered_at"),
  endedAt: integer("ended_at"),
  durationSeconds: integer("duration_seconds").notNull().default(0),
});

export const relaySettings = sqliteTable("relay_settings", {
  url: text().primaryKey().notNull(),
  enabled: integer({ mode: "boolean" }).notNull().default(true),
  general: integer({ mode: "boolean" }).notNull().default(true),
  inbox: integer({ mode: "boolean" }).notNull().default(true),
  discovery: integer({ mode: "boolean" }).notNull().default(false),
});

export const settings = sqliteTable("settings", {
  key: text().primaryKey().notNull(),
  value: text().notNull(),
});
