import { CompileNoteSchema } from "@shelfkit/schema";
import { describe, expect, it } from "vitest";

import { NOTE_SEVERITY, conflictsOf } from "../src/index.ts";

const note = (code: string, notePath = "profiles/p.json") => ({
  code,
  message: `${code} happened`,
  path: notePath,
});

const resolution = (notices: ReturnType<typeof note>[]) => ({ notices });
const plan = (notes: ReturnType<typeof note>[]) => ({ notes });

describe("the conflict panel", () => {
  it("lists errors, then warnings, then information, each note once", () => {
    const conflicts = conflictsOf(resolution([note("unratified-lsp")]), {
      errors: [{ message: "broken", path: "items/x/item.json" }],
      plan: plan([note("hosted-mcp"), note("unratified-lsp")]),
    });
    expect(conflicts).toStrictEqual([
      {
        code: "compile-error",
        message: "broken",
        path: "items/x/item.json",
        severity: "error",
      },
      { ...note("unratified-lsp"), severity: "warning" },
      { ...note("hosted-mcp"), severity: "info" },
    ]);
  });

  it("weighs a code it does not know as a warning", () => {
    expect(
      conflictsOf(null, { errors: [], plan: plan([note("brand-new")]) })
    ).toStrictEqual([{ ...note("brand-new"), severity: "warning" }]);
  });

  it("weighs every code a compile note can carry", () => {
    expect([...NOTE_SEVERITY.keys()].toSorted()).toStrictEqual(
      CompileNoteSchema.entries.code.options.toSorted()
    );
  });
});
