CREATE TABLE `message_translations` (
	`message_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`target_language` text NOT NULL,
	`source_language` text NOT NULL,
	`translated_text` text NOT NULL,
	`engine` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`message_id`, `target_language`, `content_hash`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TRIGGER `invalidate_message_translations`
AFTER UPDATE OF `body`, `deleted_at` ON `messages`
WHEN OLD.`body` IS NOT NEW.`body` OR NEW.`deleted_at` IS NOT NULL
BEGIN
  DELETE FROM `message_translations` WHERE `message_id` = NEW.`id`;
END;
