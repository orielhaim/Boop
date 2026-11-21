CREATE TABLE `avatar_cache` (
	`public_key` text PRIMARY KEY NOT NULL,
	`source_url` text NOT NULL,
	`filename` text NOT NULL,
	`size` integer NOT NULL,
	`fetched_at` integer NOT NULL,
	`accessed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nostr_profiles` (
	`public_key` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`fields` text NOT NULL,
	`picture` text,
	`name` text,
	`about` text,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
UPDATE `contacts` SET `avatar_url` = NULL WHERE `avatar_url` IS NOT NULL;
