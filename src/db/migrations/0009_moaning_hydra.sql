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
CREATE INDEX `message_timelocks_pending` ON `message_timelocks` (`retry_at`,`unlock_round`,`message_id`) WHERE "message_timelocks"."retry_at" IS NOT NULL;