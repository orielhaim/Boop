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

export const settings = sqliteTable("settings", {
  key: text().primaryKey().notNull(),
  value: text().notNull(),
});

export const speechJobs = sqliteTable(
  "speech_jobs",
  {
    id: text().primaryKey(),
    account: text().notNull(),
    attachment: text().notNull(),
    job: text().notNull(),
    sealed: text(),
  },
  (table) => [index("speech_jobs_account").on(table.account)],
);

export const peerPermissions = sqliteTable("peer_permissions", {
  publicKey: text("public_key").primaryKey().notNull(),
  blockedAt: integer("blocked_at"),
  initiated: integer({ mode: "boolean" }).notNull().default(false),
  approved: integer({ mode: "boolean" }).notNull().default(false),
});

export const downloads = sqliteTable(
  "downloads",
  {
    id: text("id").notNull(),
    account: text("account").notNull(),
    job: text("job").notNull(),
  },
  (table) => [primaryKey({ columns: [table.account, table.id] })],
);
