/**
 * Full-text search over one shelf's items, through the FTS5 table `item_search`. There is no cross-shelf index: each
 * shelf's object searches its own database (`docs/PRD.md` section 10.1).
 */

/** Markers `snippet()` puts around a match, so a body match can be told from none; stripped before answering. */
const OPEN = "\u0002";
const CLOSE = "\u0003";

/**
 * A user's text as an FTS5 query: each word quoted (so no word is read as an operator) and prefix-matched, every word
 * required. `null` when the text has no word.
 */
export function ftsQuery(text: string): string | null {
  const words = text
    .split(/[\s"]+/u)
    .map((word) => word.replaceAll(/[^\p{L}\p{N}_-]/gu, ""))
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return null;
  }
  return words.map((word) => `"${word}"*`).join(" ");
}

/** The SQL that ranks matches, with a snippet of the body column (4) around the match. */
export const SEARCH_SQL = `
  SELECT item_id AS id,
         snippet(item_search, 4, '${OPEN}', '${CLOSE}', '…', 16) AS snippet
    FROM item_search
   WHERE item_search MATCH ?
   ORDER BY bm25(item_search, 0.0, 10.0, 4.0, 6.0, 1.0)`;

/** A body snippet when the match is in the body, without its markers; `undefined` when the match was elsewhere. */
export function bodySnippet(raw: string | null): string | undefined {
  if (raw === null || !raw.includes(OPEN)) {
    return undefined;
  }
  return raw
    .replaceAll(OPEN, "")
    .replaceAll(CLOSE, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}
