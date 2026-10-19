/**
 * A line diff for revision history: the longest common subsequence of lines, then the edits around it. Prompts and
 * item files are short, so the quadratic table is cheap; a file past `LIMIT` lines is shown as replaced whole rather
 * than diffed.
 */

export type DiffLine =
  | {
      readonly kind: "same";
      readonly text: string;
      readonly before: number;
      readonly after: number;
    }
  | { readonly kind: "removed"; readonly text: string; readonly before: number }
  | { readonly kind: "added"; readonly text: string; readonly after: number };

const LIMIT = 4000;

function lines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const split = text.replaceAll("\r\n", "\n").split("\n");
  if (split.at(-1) === "") {
    split.pop();
  }
  return split;
}

/** Every line of `before` and `after`, each marked same, removed, or added, in reading order. Numbers are 1-based. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  if (a.length > LIMIT || b.length > LIMIT) {
    return [
      ...a.map((text, index): DiffLine => ({
        before: index + 1,
        kind: "removed",
        text,
      })),
      ...b.map((text, index): DiffLine => ({
        after: index + 1,
        kind: "added",
        text,
      })),
    ];
  }
  // lengths[i][j]: the LCS length of a[i..] and b[j..].
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              lengths[(i + 1) * width + j] ?? 0,
              lengths[i * width + j + 1] ?? 0
            );
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && right !== undefined && left === right) {
      out.push({ after: j + 1, before: i + 1, kind: "same", text: left });
      i += 1;
      j += 1;
    } else if (
      right !== undefined &&
      (left === undefined ||
        (lengths[i * width + j + 1] ?? 0) >=
          (lengths[(i + 1) * width + j] ?? 0))
    ) {
      out.push({ after: j + 1, kind: "added", text: right });
      j += 1;
    } else if (left !== undefined) {
      out.push({ before: i + 1, kind: "removed", text: left });
      i += 1;
    }
  }
  return out;
}

/** How many lines a diff adds and removes. */
export interface DiffStat {
  readonly added: number;
  readonly removed: number;
}

export function diffStat(diff: readonly DiffLine[]): DiffStat {
  return {
    added: diff.filter((line) => line.kind === "added").length,
    removed: diff.filter((line) => line.kind === "removed").length,
  };
}
