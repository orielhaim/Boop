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
ALTER TABLE `messages` ADD `edited_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `revision_id` text;
--> statement-breakpoint
CREATE TRIGGER `remove_deleted_message_edits`
AFTER UPDATE OF `deleted_at` ON `messages`
WHEN OLD.`deleted_at` IS NULL AND NEW.`deleted_at` IS NOT NULL
BEGIN
  DELETE FROM `message_revisions` WHERE `message_id` = NEW.`id`;
  DELETE FROM `message_edit_outbox` WHERE `message_id` = NEW.`id`;
  DELETE FROM `pending_message_edits` WHERE `target_id` = NEW.`event_id`;
  UPDATE `messages` SET `edited_at` = NULL, `revision_id` = NULL WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `remove_blocked_pending_edits`
AFTER INSERT ON `blocked_identities`
BEGIN
  DELETE FROM `pending_message_edits` WHERE `peer_key` = NEW.`public_key`;
END;
