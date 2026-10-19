CREATE TABLE `github_grant` (
	`created_at` text NOT NULL,
	`github_id` text PRIMARY KEY,
	`login` text NOT NULL,
	`scopes` text NOT NULL
);
