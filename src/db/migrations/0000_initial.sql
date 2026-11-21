CREATE TABLE `attachment_cache` (
	`owner` text NOT NULL,
	`hash` text NOT NULL,
	`source` text NOT NULL,
	`size` integer NOT NULL,
	`accessed_at` integer NOT NULL,
	PRIMARY KEY(`owner`, `source`, `hash`)
);
--> statement-breakpoint
CREATE TABLE `attachment_uploads` (
	`message_id` text PRIMARY KEY NOT NULL,
	`native_id` text NOT NULL,
	`owner` text NOT NULL,
	`peer` text NOT NULL,
	`hash` text NOT NULL,
	`source` text NOT NULL,
	`origin` text NOT NULL,
	`result_url` text,
	FOREIGN KEY (`message_id`) REFERENCES `message_attachments`(`message_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_uploads_native_id_unique` ON `attachment_uploads` (`native_id`);--> statement-breakpoint
CREATE TABLE `avatar_cache` (
	`public_key` text PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	`accessed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `call_history` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_key` text NOT NULL,
	`participant_keys` text DEFAULT '[]' NOT NULL,
	`invitation_ids` text DEFAULT '[]' NOT NULL,
	`direction` text NOT NULL,
	`outcome` text NOT NULL,
	`started_at` integer NOT NULL,
	`answered_at` integer,
	`ended_at` integer,
	`duration_seconds` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `call_history_recent` ON `call_history` (`started_at`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`public_key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`local_avatar_file` text,
	`favorite` integer DEFAULT false NOT NULL,
	`allow_incoming_video` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`peer_key` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	`draft` text DEFAULT '' NOT NULL,
	`draft_reply_to` text,
	`pinned_rank` integer,
	`muted` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `conversations_order` ON `conversations` ("pinned_rank" IS NULL,`pinned_rank`,"updated_at" DESC,`peer_key`) WHERE "conversations"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `link_preview_cache` (
	`url` text PRIMARY KEY NOT NULL,
	`site_name` text,
	`title` text,
	`description` text,
	`image` text,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`message_id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`file` text NOT NULL,
	`url` text,
	`listened` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_attachments_hash` ON `message_attachments` (`hash`);--> statement-breakpoint
CREATE TABLE `message_edit_outbox` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`rumor_json` text NOT NULL,
	`status` text NOT NULL,
	`failure` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_edit_outbox_message` ON `message_edit_outbox` (`message_id`);--> statement-breakpoint
CREATE INDEX `message_edit_outbox_status` ON `message_edit_outbox` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_edit_outbox_recipient` ON `message_edit_outbox` (`message_id`) WHERE "message_edit_outbox"."status" IN ('pending', 'failed');--> statement-breakpoint
CREATE TABLE `message_reactions` (
	`peer_key` text NOT NULL,
	`target_id` text NOT NULL,
	`author` text NOT NULL,
	`emoji` text NOT NULL,
	`removed` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`peer_key`, `target_id`, `author`, `emoji`),
	FOREIGN KEY (`peer_key`) REFERENCES `conversations`(`peer_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `message_requests` (
	`public_key` text PRIMARY KEY NOT NULL,
	`received_at` integer NOT NULL,
	`messages` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_revisions` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`previous_revision_id` text,
	`body` text NOT NULL,
	`timestamp` integer NOT NULL,
	`depth` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_revisions_history` ON `message_revisions` (`message_id`,`depth`,`timestamp`,`revision_id`);--> statement-breakpoint
CREATE TABLE `message_timelocks` (
	`message_id` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`chain_hash` text NOT NULL,
	`unlock_round` integer NOT NULL,
	`requested_at` integer NOT NULL,
	`round_time` integer NOT NULL,
	`opened_at` integer,
	`retry_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_timelocks_pending` ON `message_timelocks` (`retry_at`,`unlock_round`,`message_id`) WHERE "message_timelocks"."retry_at" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `message_translations` (
	`message_id` text NOT NULL,
	`target_language` text NOT NULL,
	`source_language` text NOT NULL,
	`translated_text` text NOT NULL,
	PRIMARY KEY(`message_id`, `target_language`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`peer_key` text NOT NULL,
	`direction` text NOT NULL,
	`body` text NOT NULL,
	`sent_at` integer NOT NULL,
	`pinned_at` integer,
	`edited_at` integer,
	`revision_id` text,
	`reply_to` text,
	`sender_key` text,
	`recipient_key` text,
	`status` text DEFAULT 'received' NOT NULL,
	`failure` text,
	`deleted_at` integer,
	`is_unread` integer DEFAULT false NOT NULL,
	`rumor_json` text,
	`content_type` text DEFAULT 'text' NOT NULL,
	FOREIGN KEY (`peer_key`) REFERENCES `conversations`(`peer_key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "messages_read_direction" CHECK("messages"."is_unread" = 0 OR "messages"."direction" = 'incoming')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_event_id_unique` ON `messages` (`event_id`);--> statement-breakpoint
CREATE INDEX `messages_peer_order` ON `messages` (`peer_key`,`sent_at`,`id`) WHERE "messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `messages_unread` ON `messages` (`peer_key`,`sent_at`,`id`) WHERE "messages"."is_unread" = 1 AND "messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `messages_pinned` ON `messages` (`peer_key`,`pinned_at`,`id`) WHERE "messages"."pinned_at" IS NOT NULL AND "messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `messages_attachment_copies` ON `messages` (`sent_at`,`id`) WHERE "messages"."status" = 'sent' AND "messages"."content_type" = 'attachment' AND "messages"."deleted_at" IS NULL AND "messages"."rumor_json" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `messages_outbox` ON `messages` (`sent_at`,`id`) WHERE "messages"."status" = 'pending' AND "messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `nostr_profiles` (
	`public_key` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`fields` text NOT NULL,
	`picture` text,
	`name` text
);
--> statement-breakpoint
CREATE TABLE `peer_permissions` (
	`public_key` text PRIMARY KEY NOT NULL,
	`blocked_at` integer,
	`initiated` integer DEFAULT false NOT NULL,
	`approved` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pending_message_edits` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`previous_revision_id` text NOT NULL,
	`peer_key` text NOT NULL,
	`sender_key` text NOT NULL,
	`recipient_key` text NOT NULL,
	`body` text NOT NULL,
	`timestamp` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_message_edits_parent` ON `pending_message_edits` (`target_id`,`previous_revision_id`);--> statement-breakpoint
CREATE INDEX `pending_message_edits_peer` ON `pending_message_edits` (`peer_key`);--> statement-breakpoint
CREATE INDEX `pending_message_edits_expiry` ON `pending_message_edits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `relay_settings` (
	`url` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`general` integer DEFAULT true NOT NULL,
	`inbox` integer DEFAULT true NOT NULL,
	`discovery` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER grant_on_message_delivery
AFTER UPDATE OF status ON messages
WHEN NEW.direction = 'outgoing' AND NEW.status = 'sent' AND OLD.status <> 'sent'
BEGIN
  INSERT INTO peer_permissions (public_key, initiated) VALUES (NEW.peer_key, 1)
  ON CONFLICT(public_key) DO UPDATE SET initiated = 1;
END;
--> statement-breakpoint
CREATE TRIGGER invalidate_message_translations
AFTER UPDATE OF body ON messages
WHEN OLD.body IS NOT NEW.body
BEGIN
  DELETE FROM message_translations WHERE message_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER remove_deleted_message_content
AFTER UPDATE OF deleted_at ON messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM message_revisions WHERE message_id = NEW.id;
  DELETE FROM message_edit_outbox WHERE message_id = NEW.id;
  DELETE FROM pending_message_edits WHERE target_id = NEW.event_id;
  DELETE FROM message_translations WHERE message_id = NEW.id;
  DELETE FROM message_attachments WHERE message_id = NEW.id;
  DELETE FROM message_timelocks WHERE message_id = NEW.id;
  UPDATE messages SET edited_at = NULL, revision_id = NULL WHERE id = NEW.id;
END;
--> statement-breakpoint
PRAGMA user_version = 1;
