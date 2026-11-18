CREATE TABLE `call_history` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_key` text NOT NULL,
	`direction` text NOT NULL,
	`outcome` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_seconds` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`public_key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`favorite` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`peer_key` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	`unread` integer DEFAULT 0 NOT NULL,
	`draft` text DEFAULT '' NOT NULL,
	`draft_reply_to` text
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`peer_key` text NOT NULL,
	`direction` text NOT NULL,
	`body` text NOT NULL,
	`sent_at` integer NOT NULL,
	`reply_to` text,
	FOREIGN KEY (`peer_key`) REFERENCES `conversations`(`peer_key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_event_id_unique` ON `messages` (`event_id`);--> statement-breakpoint
CREATE INDEX `messages_peer_time` ON `messages` (`peer_key`,`sent_at`);--> statement-breakpoint
CREATE TABLE `relay_settings` (
	`url` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
