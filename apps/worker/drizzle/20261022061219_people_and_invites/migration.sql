CREATE TABLE `access_grant` (
	`created_at` text NOT NULL,
	`name` text NOT NULL,
	`principal` text PRIMARY KEY,
	`scopes` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invite` (
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`revoked_at` text,
	`scopes` text NOT NULL,
	`token_hash` text NOT NULL,
	`used_at` text,
	`used_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_token` ON `invite` (`token_hash`);