ALTER TABLE `relay_settings` ADD `general` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `relay_settings` ADD `inbox` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `relay_settings` ADD `discovery` integer DEFAULT false NOT NULL;