CREATE TABLE `repository_entry` (
	`path` text PRIMARY KEY,
	`mode` text NOT NULL,
	`id` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `snapshot` ADD `commit` text;