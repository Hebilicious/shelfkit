-- The full-text index over items: titles, descriptions, tags, and the body a prompt, an agent, or a skill carries.
-- Drizzle does not model FTS5 tables, so this migration is written by hand. It is a derived index, rebuilt from R2
-- whenever the shelf's snapshot changes; the content of record is the R2 object.
CREATE VIRTUAL TABLE `item_search` USING fts5(
	`item_id` UNINDEXED,
	`title`,
	`description`,
	`tags`,
	`body`,
	tokenize = 'unicode61 remove_diacritics 2'
);
