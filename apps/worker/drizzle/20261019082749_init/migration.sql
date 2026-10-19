CREATE TABLE `activity` (
	`apm_yml_digest` text NOT NULL,
	`commit` text,
	`id` text PRIMARY KEY,
	`key_id` text,
	`message` text,
	`outcome` text NOT NULL,
	`profile_id` text NOT NULL,
	`profile_revision` text NOT NULL,
	`recorded_at` text NOT NULL,
	`repository` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `api_key` (
	`created_at` text NOT NULL,
	`hash` text NOT NULL,
	`id` text PRIMARY KEY,
	`last_used_at` text,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`revoked_at` text,
	`scopes` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blob` (
	`created_at` text NOT NULL,
	`sha256` text PRIMARY KEY,
	`size` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bundle` (
	`document` text NOT NULL,
	`id` text PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE `favourite` (
	`created_at` text NOT NULL,
	`item_id` text NOT NULL,
	`key_id` text NOT NULL,
	CONSTRAINT `favourite_pk` PRIMARY KEY(`key_id`, `item_id`)
);
--> statement-breakpoint
CREATE TABLE `file` (
	`path` text PRIMARY KEY,
	`sha256` text NOT NULL,
	`size` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_job` (
	`candidates` text,
	`created_at` text NOT NULL,
	`error` text,
	`id` text PRIMARY KEY,
	`imported` text,
	`key_id` text,
	`picks` text,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL,
	`warnings` text
);
--> statement-breakpoint
CREATE TABLE `item` (
	`coordinate` text NOT NULL,
	`created_at` text NOT NULL,
	`description` text NOT NULL,
	`document` text NOT NULL,
	`files` text NOT NULL,
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`requires` text NOT NULL,
	`revision` text NOT NULL,
	`tags` text NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `package_version` (
	`digest` text NOT NULL,
	`key_id` text,
	`package` text NOT NULL,
	`published_at` text NOT NULL,
	`sequence` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`version` text NOT NULL,
	CONSTRAINT `package_version_pk` PRIMARY KEY(`package`, `version`)
);
--> statement-breakpoint
CREATE TABLE `profile` (
	`created_at` text NOT NULL,
	`document` text NOT NULL,
	`id` text PRIMARY KEY,
	`path` text NOT NULL,
	`resolution` text NOT NULL,
	`revision` text NOT NULL,
	`title` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profile_revision` (
	`created_at` text NOT NULL,
	`document` text NOT NULL,
	`profile_id` text NOT NULL,
	`revision` text NOT NULL,
	`snapshot` text NOT NULL,
	CONSTRAINT `profile_revision_pk` PRIMARY KEY(`profile_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `recent` (
	`item_id` text NOT NULL,
	`key_id` text NOT NULL,
	`used_at` text NOT NULL,
	`uses` integer NOT NULL,
	CONSTRAINT `recent_pk` PRIMARY KEY(`key_id`, `item_id`)
);
--> statement-breakpoint
CREATE TABLE `revision` (
	`created_at` text NOT NULL,
	`document` text NOT NULL,
	`files` text NOT NULL,
	`item_id` text NOT NULL,
	`key_id` text,
	`message` text,
	`revision` text NOT NULL,
	`snapshot` text NOT NULL,
	CONSTRAINT `revision_pk` PRIMARY KEY(`item_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `scan` (
	`details_url` text,
	`id` text PRIMARY KEY,
	`item_id` text NOT NULL,
	`observed` text,
	`recorded_at` text NOT NULL,
	`revision` text NOT NULL,
	`scanner` text NOT NULL,
	`summary` text,
	`verdict` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secret_name` (
	`created_at` text NOT NULL,
	`description` text,
	`name` text PRIMARY KEY
);
--> statement-breakpoint
CREATE TABLE `share_link` (
	`created_at` text NOT NULL,
	`id` text PRIMARY KEY,
	`key_id` text,
	`profile_id` text NOT NULL,
	`revoked_at` text,
	`token_hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshot` (
	`created_at` text NOT NULL,
	`digest` text PRIMARY KEY,
	`file_count` integer NOT NULL,
	`key_id` text,
	`message` text,
	`origin` text NOT NULL,
	`parent` text,
	`total_bytes` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `upstream` (
	`checked_at` text NOT NULL,
	`error` text,
	`item_id` text PRIMARY KEY,
	`latest` text,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_profile` ON `activity` (`profile_id`);--> statement-breakpoint
CREATE INDEX `activity_recorded` ON `activity` (`recorded_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_key_hash` ON `api_key` (`hash`);--> statement-breakpoint
CREATE INDEX `item_kind` ON `item` (`kind`);--> statement-breakpoint
CREATE INDEX `scan_item_revision` ON `scan` (`item_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `share_link_token` ON `share_link` (`token_hash`);