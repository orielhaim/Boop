CREATE TABLE `attachment_cache` (
	`owner` text NOT NULL,
	`hash` text NOT NULL,
	`source` text NOT NULL,
	`size` integer NOT NULL,
	`accessed_at` integer NOT NULL,
	PRIMARY KEY(`owner`, `hash`, `source`)
);
--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`message_id` text PRIMARY KEY NOT NULL,
	`file` text NOT NULL,
	`url` text,
	`listened` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TRIGGER `message_attachment_delete`
AFTER UPDATE OF `deleted_at` ON `messages`
WHEN NEW.`deleted_at` IS NOT NULL
BEGIN
  DELETE FROM `message_attachments` WHERE `message_id` = NEW.`id`;
END;
