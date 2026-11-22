import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const contacts = sqliteTable("contacts", {
  publicKey: text("public_key").primaryKey().notNull(),
  name: text().notNull(),
  localAvatarFile: text("local_avatar_file"),
  favorite: integer({ mode: "boolean" }).notNull().default(false),
  allowIncomingVideo: integer("allow_incoming_video", { mode: "boolean" })
    .notNull()
    .default(false),
});

export const linkPreviewCache = sqliteTable("link_preview_cache", {
  url: text().primaryKey(),
  siteName: text("site_name"),
  title: text(),
  description: text(),
  image: text(),
  fetchedAt: integer("fetched_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const callHistory = sqliteTable(
  "call_history",
  {
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
  },
  (table) => [index("call_history_recent").on(table.startedAt)],
);

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

export const peerPermissions = sqliteTable("peer_permissions", {
  publicKey: text("public_key").primaryKey().notNull(),
  blockedAt: integer("blocked_at"),
  initiated: integer({ mode: "boolean" }).notNull().default(false),
  approved: integer({ mode: "boolean" }).notNull().default(false),
});

export const nostrProfiles = sqliteTable("nostr_profiles", {
  publicKey: text("public_key").primaryKey().notNull(),
  eventId: text("event_id").notNull(),
  createdAt: integer("created_at").notNull(),
  fields: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  picture: text(),
  name: text(),
});

export const avatarCache = sqliteTable("avatar_cache", {
  publicKey: text("public_key").primaryKey().notNull(),
  sourceUrl: text("source_url").notNull(),
  filename: text().notNull(),
  size: integer().notNull(),
  fetchedAt: integer("fetched_at").notNull(),
  accessedAt: integer("accessed_at").notNull(),
});
