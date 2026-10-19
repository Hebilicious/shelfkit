/**
 * TEMPORARY MIRROR of the Worker's `conflictsOf` (`apps/worker/src/graphql/schema.ts`), for the composer's in-browser
 * preview. The shared implementation is moving into `@shelfkit/engine` (branch `feat/7-engine-output`); when it lands,
 * this file is deleted and the composer imports that one. Keep it identical to the Worker's until then.
 */
import type { Notice } from "@shelfkit/schema";

export type Severity = "error" | "warning" | "info";

export interface Conflict {
  readonly severity: Severity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** How a compile note weighs in the composer's conflict panel. */
const NOTE_SEVERITY = new Map<string, Severity>([
  ["hook-approval", "warning"],
  ["hosted-mcp", "info"],
  ["mcp-schema-mismatch", "warning"],
  ["producer-nonconformant-target", "warning"],
  ["unratified-lsp", "warning"],
]);

interface ProblemLike {
  readonly path: string;
  readonly message: string;
}

interface NoteLike {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** Every problem a profile has, by severity: engine errors, then the resolver's notices, then the compiler's notes. */
export function conflictsOf(
  notices: readonly Notice[] | readonly NoteLike[],
  errors: readonly ProblemLike[],
  notes: readonly NoteLike[]
): Conflict[] {
  const conflicts: Conflict[] = errors.map((error) => ({
    code: "compile-error",
    message: error.message,
    path: error.path,
    severity: "error",
  }));
  const seen = new Set<string>();
  for (const note of [...notices, ...notes]) {
    const key = `${note.code} ${note.path} ${note.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      conflicts.push({
        code: note.code,
        message: note.message,
        path: note.path,
        severity: NOTE_SEVERITY.get(note.code) ?? "warning",
      });
    }
  }
  const order = { error: 0, info: 2, warning: 1 } as const;
  return conflicts.toSorted((a, b) => order[a.severity] - order[b.severity]);
}
