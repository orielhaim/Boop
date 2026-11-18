CREATE TABLE `message_reactions` (
	`peer_key` text NOT NULL,
	`target_id` text NOT NULL,
	`author` text NOT NULL,
	`emoji` text NOT NULL,
	`removed` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`peer_key`, `target_id`, `author`, `emoji`),
	FOREIGN KEY (`peer_key`) REFERENCES `conversations`(`peer_key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
DROP INDEX `messages_peer_time`;--> statement-breakpoint
ALTER TABLE `messages` ADD `sender_key` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `recipient_key` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `status` text DEFAULT 'received' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `failure` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `is_unread` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `rumor_json` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `content_type` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
CREATE INDEX `messages_peer_order` ON `messages` (`peer_key`,`sent_at`,`id`) WHERE "messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `messages_unread` ON `messages` (`peer_key`,`sent_at`,`id`) WHERE "messages"."is_unread" = 1 AND "messages"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `messages_outbox` ON `messages` (`sent_at`,`id`) WHERE "messages"."status" = 'pending' AND "messages"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `pinned_rank` integer;--> statement-breakpoint
ALTER TABLE `conversations` ADD `muted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `deleted_at` integer;--> statement-breakpoint
UPDATE `messages`
SET `sender_key` = CASE `direction` WHEN 'incoming' THEN `peer_key` ELSE (SELECT `value` FROM `settings` WHERE `key` = 'identity.publicKey') END,
    `recipient_key` = CASE `direction` WHEN 'outgoing' THEN `peer_key` ELSE (SELECT `value` FROM `settings` WHERE `key` = 'identity.publicKey') END,
    `status` = CASE WHEN `direction` = 'incoming' THEN 'received' WHEN `event_id` IS NOT NULL THEN 'synced' ELSE 'failed' END,
    `failure` = CASE WHEN `direction` = 'outgoing' AND `event_id` IS NULL THEN 'legacy_message' END;--> statement-breakpoint
WITH unread_rank AS (
    SELECT `id`, `peer_key`, row_number() OVER (PARTITION BY `peer_key` ORDER BY `sent_at` DESC, `id` DESC) AS rank
    FROM `messages` WHERE `direction` = 'incoming'
)
UPDATE `messages` SET `is_unread` = 1 WHERE `id` IN (
    SELECT unread_rank.`id` FROM unread_rank JOIN `conversations` USING (`peer_key`)
    WHERE unread_rank.rank <= `conversations`.`unread`
);--> statement-breakpoint
UPDATE `conversations` SET `unread` = (SELECT count(*) FROM `messages` WHERE `messages`.`peer_key` = `conversations`.`peer_key` AND `is_unread` = 1);
