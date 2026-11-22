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
PRAGMA user_version = 2;
