CREATE TABLE `downloads` (
	`id` text NOT NULL,
	`account` text NOT NULL,
	`job` text NOT NULL,
	PRIMARY KEY(`account`, `id`)
);
