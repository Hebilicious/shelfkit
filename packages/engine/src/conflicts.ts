/**
 * The composer's conflict panel: every problem a profile has, by severity. Shared by the Worker's GraphQL API and the web
 * UI, so the two list the same conflicts for the same profile.
 */
export type ConflictSeverity = "error" | "warning" | "info";

export interface Conflict {
  readonly severity: ConflictSeverity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** A resolver notice or a compile note: what a `ResolvedProfile`'s `notices` and a `CompilePlan`'s `notes` hold. */
export interface Note {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

/** A compile's outcome: the plan (only its notes are read), or `null` and the errors, each in its file. */
export interface PlanOutcome {
  readonly plan: { readonly notes: readonly Note[] } | null;
  readonly errors: readonly {
    readonly path: string;
    readonly message: string;
  }[];
}

/** How a resolver notice or compile note weighs in the conflict panel, by its code. An unknown code is a warning. */
export const NOTE_SEVERITY: ReadonlyMap<string, ConflictSeverity> = new Map<
  string,
  ConflictSeverity
>([
  ["doc-link", "warning"],
  ["hook-approval", "warning"],
  ["hosted-mcp", "info"],
  ["mcp-schema-mismatch", "warning"],
  ["producer-nonconformant-target", "warning"],
  ["skill-frontmatter", "warning"],
  ["unratified-lsp", "warning"],
]);

const ORDER = { error: 0, info: 2, warning: 1 } as const;

/**
 * Every problem a profile has, errors first, then warnings, then information: the compile's errors, then the resolver's
 * notices, then the compiler's notes, each note once.
 */
export function conflictsOf(
  resolution: { readonly notices: readonly Note[] } | null,
  plan: PlanOutcome
): Conflict[] {
  const conflicts: Conflict[] = plan.errors.map((error) => ({
    code: "compile-error",
    message: error.message,
    path: error.path,
    severity: "error",
  }));
  const notes = [...(resolution?.notices ?? []), ...(plan.plan?.notes ?? [])];
  const seen = new Set<string>();
  for (const note of notes) {
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
  return conflicts.toSorted((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
