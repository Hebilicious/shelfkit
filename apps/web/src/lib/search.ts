/**
 * Search over items the browser already holds, so the shelf and the prompt list filter as you type with no request.
 * Every word must appear, each as the start of a word, in the title, id, tags, description, or body; a match in the
 * title ranks above one in the tags, the description, then the body, as the service's own full-text search ranks them.
 */

export interface Searchable {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly body?: string | null;
}

export interface Match<T> {
  readonly item: T;
  /** Where the words appear in the body, when only the body has them. */
  readonly snippet: string | null;
}

/** How much text a snippet keeps on each side of the match. */
const CONTEXT = 60;

/** The words of a search, folded; empty when it has none. */
export function searchWords(text: string): string[] {
  return text
    .split(/[\s"]+/u)
    .map((word) => fold(word.replaceAll(/[^\p{L}\p{N}_-]/gu, "")))
    .filter((word) => word.length > 0);
}

/** Lowercase with diacritics removed, keeping every character's position. */
function fold(text: string): string {
  // oxlint-disable-next-line typescript/no-misused-spread -- folding is per code point, and a code point keeps its UTF-16 length, so positions stay aligned.
  return [...text]
    .map((char) => {
      const base = char.normalize("NFD").replaceAll(/\p{M}/gu, "");
      return base.length === char.length
        ? base.toLowerCase()
        : char.toLowerCase();
    })
    .join("");
}

function escape(word: string): string {
  return word.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function wordStart(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}`, "u");
}

/** Where in `text` the earliest of `patterns` matches, or -1. */
function firstMatch(folded: string, patterns: readonly RegExp[]): number {
  let at = -1;
  for (const pattern of patterns) {
    const found = folded.search(pattern);
    if (found !== -1 && (at === -1 || found < at)) {
      at = found;
    }
  }
  return at;
}

function snippetAt(body: string, at: number): string {
  const start = Math.max(0, at - CONTEXT);
  const end = Math.min(body.length, at + CONTEXT * 2);
  const text = body.slice(start, end).replaceAll(/\s+/gu, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${end < body.length ? "…" : ""}`;
}

/** The items matching `text`, best first; every item, in its order, when `text` has no word. */
export function search<T extends Searchable>(
  items: readonly T[],
  text: string
): Match<T>[] {
  const words = searchWords(text);
  if (words.length === 0) {
    return items.map((item) => ({ item, snippet: null }));
  }
  const patterns = words.map(wordStart);
  const scored: { match: Match<T>; score: number; order: number }[] = [];
  for (const [order, item] of items.entries()) {
    const fields = [
      { text: fold(`${item.title} ${item.id}`), weight: 10 },
      { text: fold(item.tags.join(" ")), weight: 6 },
      { text: fold(item.description), weight: 4 },
      { text: fold(item.body ?? ""), weight: 1 },
    ];
    let score = 0;
    let everyWord = true;
    for (const pattern of patterns) {
      const hit = fields.find((field) => pattern.test(field.text));
      if (hit === undefined) {
        everyWord = false;
        break;
      }
      score += hit.weight;
    }
    if (everyWord) {
      const inHeadline = patterns.every((pattern) =>
        fields.slice(0, 3).some((field) => pattern.test(field.text))
      );
      const body = item.body ?? "";
      const at = inHeadline ? -1 : firstMatch(fold(body), patterns);
      scored.push({
        match: { item, snippet: at === -1 ? null : snippetAt(body, at) },
        order,
        score,
      });
    }
  }
  return scored
    .toSorted((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.match);
}
