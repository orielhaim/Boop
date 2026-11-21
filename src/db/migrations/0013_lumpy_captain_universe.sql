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
CREATE TABLE `message_pins` (
	`message_id` text PRIMARY KEY NOT NULL,
	`peer_key` text NOT NULL,
	`pinned_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_pins_peer` ON `message_pins` (`peer_key`,`pinned_at`);