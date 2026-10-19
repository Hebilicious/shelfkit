/**
 * Full-text search over one shelf's items, through the FTS5 table `item_search`. There is no cross-shelf index: each
 * shelf's object searches its own database (`docs/PRD.md` section 10.1).
 *
 * The table is contentless (`content=''`): it keeps the index's terms and no text, so the database holds no prompt
 * body. `item_search_row` maps its rowids to items, and a snippet is cut from the item's content, which the object
 * holds in memory from R2.
 */

/** The words of a user's text, as the index tokenizes them closely enough to quote each. */
export function queryWords(text: string): string[] {
  return text
    .split(/[\s"]+/u)
    .map((word) => word.replaceAll(/[^\p{L}\p{N}_-]/gu, ""))
    .filter((word) => word.length > 0);
}

/**
 * A user's text as an FTS5 query: each word quoted (so no word is read as an operator) and prefix-matched, every word
 * required. `null` when the text has no word.
 */
export function ftsQuery(text: string): string | null {
  const words = queryWords(text);
  if (words.length === 0) {
    return null;
  }
  return words.map((word) => `"${word}"*`).join(" ");
}

/** The SQL that ranks matches: titles weigh most, then tags, then descriptions, then bodies. */
export const SEARCH_SQL = `
  SELECT row.item_id AS id
    FROM item_search
    JOIN item_search_row AS row ON row.rowid = item_search.rowid
   WHERE item_search MATCH ?
   ORDER BY bm25(item_search, 10.0, 4.0, 6.0, 1.0)`;

/** How much text a snippet keeps on each side of the match. */
const CONTEXT = 60;

/**
 * The text around the first word of the query in `body`, when the body has one; `undefined` when the match was
 * elsewhere (a title, a tag).
 */
export function bodySnippet(
  body: string,
  words: readonly string[]
): string | undefined {
  const folded = fold(body);
  let at = -1;
  for (const word of words) {
    const found = folded.search(
      new RegExp(`(?<![\\p{L}\\p{N}])${escape(fold(word))}`, "u")
    );
    if (found !== -1 && (at === -1 || found < at)) {
      at = found;
    }
  }
  if (at === -1) {
    return undefined;
  }
  const start = Math.max(0, at - CONTEXT);
  const end = Math.min(body.length, at + CONTEXT * 2);
  const text = body.slice(start, end).replaceAll(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${end < body.length ? "…" : ""}`;
}

/** Lowercase with diacritics removed, keeping every character's position. */
function fold(text: string): string {
  // oxlint-disable-next-line typescript/no-misused-spread -- folding is per code point, and a code point keeps its UTF-16 length, so positions stay aligned.
  return [...text]
    .map((char) => {
      const base = char
        .normalize("NFD")
        .replaceAll(/\p{M}/gu, "")
        .toLowerCase();
      return base.length === char.length ? base : char;
    })
    .join("");
}

function escape(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
