CREATE TABLE `speech_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`attachment` text NOT NULL,
	`job` text NOT NULL,
	`sealed` text
);
--> statement-breakpoint
CREATE INDEX `speech_jobs_account` ON `speech_jobs` (`account`);
