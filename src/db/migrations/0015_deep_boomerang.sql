CREATE TABLE `attachment_uploads` (
	`message_id` text PRIMARY KEY NOT NULL,
	`native_id` text NOT NULL,
	`owner` text NOT NULL,
	`peer` text NOT NULL,
	`hash` text NOT NULL,
	`source` text NOT NULL,
	`origin` text NOT NULL,
	`result_url` text,
	FOREIGN KEY (`message_id`) REFERENCES `message_attachments`(`message_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_uploads_native_id_unique` ON `attachment_uploads` (`native_id`);