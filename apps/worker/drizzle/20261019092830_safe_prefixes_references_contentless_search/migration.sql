-- Written by hand, because it rewrites data and Drizzle does not model FTS5 tables.
--
-- 1. A key's stored prefix was cut at the last `_` of the key, and a base64url secret may hold `_`, so a prefix could
--    carry most of the secret. Keep `sks_<shelf>_` and four characters of the secret, as `displayPrefix` now does.
UPDATE `api_key` SET `prefix` = substr(`prefix`, 1, 8 + instr(substr(`prefix`, 5), '_')) || '…';
--> statement-breakpoint
-- 2. Mark every object a commit, a revision, or a published version names; `/raw` serves only those.
UPDATE `blob` SET `referenced` = 1
 WHERE `sha256` IN (SELECT `sha256` FROM `file`)
    OR `sha256` IN (SELECT json_extract(`f`.`value`, '$.sha256') FROM `revision`, json_each(`revision`.`files`) AS `f`)
    OR 'sha256:' || `sha256` IN (SELECT `digest` FROM `snapshot`)
    OR 'sha256:' || `sha256` IN (SELECT `digest` FROM `package_version`);
--> statement-breakpoint
-- 3. The full-text index keeps no text: a contentless FTS5 table whose rowids `item_search_row` maps to items. The object
--    rebuilds it from the current snapshot when it finds it empty (`meta.search_index`).
DROP TABLE `item_search`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `item_search` USING fts5(
	`title`,
	`description`,
	`tags`,
	`body`,
	content = '',
	contentless_delete = 1,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
DELETE FROM `meta` WHERE `key` = 'search_index';
