CREATE TABLE `item_search_row` (
	`item_id` text NOT NULL UNIQUE,
	`rowid` integer PRIMARY KEY AUTOINCREMENT
);
--> statement-breakpoint
ALTER TABLE `blob` ADD `referenced` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `secret_name` ADD `origin` text;