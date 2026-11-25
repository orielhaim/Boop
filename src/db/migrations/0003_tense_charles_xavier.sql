CREATE TABLE `torrent_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`sealed` text NOT NULL,
	`bytes` integer NOT NULL,
	`touched` integer NOT NULL
);
