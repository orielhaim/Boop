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
CREATE TABLE `downloads` (
	`id` text NOT NULL,
	`account` text NOT NULL,
	`job` text NOT NULL,
	PRIMARY KEY(`account`, `id`)
);
--> statement-breakpoint
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
CREATE TABLE `peer_permissions` (
	`public_key` text PRIMARY KEY NOT NULL,
	`initiated` integer DEFAULT false NOT NULL,
	`approved` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `speech_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`attachment` text NOT NULL,
	`job` text NOT NULL,
	`sealed` text
);
--> statement-breakpoint
CREATE INDEX `speech_jobs_account` ON `speech_jobs` (`account`);--> statement-breakpoint
CREATE TABLE `torrent_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`sealed` text NOT NULL,
	`bytes` integer NOT NULL,
	`touched` integer NOT NULL
);
--> statement-breakpoint
PRAGMA user_version = 5;
