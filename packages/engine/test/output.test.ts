import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CompilePlan } from "@shelfkit/schema";
import { beforeAll, describe, expect, it } from "vitest";

import type { Engine, OnConflict, RepositoryOutput } from "../src/index.ts";
import { loadEngine, readRepository, readShelf } from "../src/node.ts";

const repository = path.resolve(import.meta.dirname, "../../..");
const binary = path.join(
  repository,
  "target/debug",
  process.platform === "win32" ? "shelfkit.exe" : "shelfkit"
);
const shelf = path.join(repository, "crates/core/tests/fixtures/all-kinds");

/** A fresh directory for one repository. */
function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "shelfkit-output-"));
}

/** Every file under `root` with its bytes, and every directory and link, by path relative to it; links are never followed. */
function tree(root: string) {
  const found = new Map<string, string>();
  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    const full = path.join(entry.parentPath, entry.name);
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) {
      found.set(relative, "<link>");
    } else if (entry.isDirectory()) {
      found.set(relative, "<directory>");
    } else if (entry.isFile()) {
      found.set(relative, readFileSync(full).toString("base64"));
    }
  }
  return found;
}

/** Write what the engine says to write and remove what it says to remove, as a browser host would. */
function apply(root: string, output: RepositoryOutput): void {
  for (const file of output.write) {
    const target = path.join(root, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      file.encoding === "base64"
        ? Buffer.from(file.contents, "base64")
        : file.contents
    );
  }
  for (const file of output.remove) {
    rmSync(path.join(root, file));
  }
  for (const directory of output.prune) {
    rmdirSync(path.join(root, directory));
  }
}

interface Ran {
  readonly status: number | null;
  readonly stderr: string;
}

function compile(repo: string, profile: string, onConflict: OnConflict): Ran {
  const ran = spawnSync(
    binary,
    [
      "--shelf",
      shelf,
      "compile",
      "--repo",
      repo,
      "--on-conflict",
      onConflict,
      profile,
    ],
    { encoding: "utf-8" }
  );
  return { status: ran.status, stderr: ran.stderr };
}

/** A repository prepared by `prepare`, twice: one for the CLI, one for the engine. */
function twins(prepare: (root: string) => void) {
  const engine = scratch();
  prepare(engine);
  const cli = scratch();
  cpSync(engine, cli, { recursive: true, verbatimSymlinks: true });
  return { cli, engine };
}

/** The engine's refusals are the lines the CLI lists under "nothing was written". */
function refusedLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("  - "))
    .map((line) => line.slice("  - ".length));
}

/** The CLI's refusal lines with the repository's own path taken off, as the engine words them. */
function relativeLines(stderr: string, root: string): string[] {
  return refusedLines(stderr).map((line) =>
    line.startsWith(`${root}/`) ? line.slice(root.length + 1) : line
  );
}

/** Bytes that are not UTF-8. */
const NOT_UTF8 = Buffer.from([0xff, 0xfe, 0x0a]);

const CONFLICTING =
  "name: my-app\nversion: 2.0.0\ntargets: [claude]\ndependencies:\n  apm:\n    - acme/standards#v1\n";

describe("Engine.output and `shelfkit compile --repo`", () => {
  let engine: Engine;
  const plans = new Map<string, CompilePlan>();

  beforeAll(async () => {
    engine = await loadEngine();
    const files = await readShelf(shelf);
    for (const profile of ["base", "minimal", "full"]) {
      const result = engine.planCompile(files, { profile });
      if (!result.ok) {
        throw new Error(JSON.stringify(result.errors));
      }
      plans.set(profile, result.plan);
    }
  });

  function planOf(profile: string): CompilePlan {
    const plan = plans.get(profile);
    if (plan === undefined) {
      throw new Error(`no plan for ${profile}`);
    }
    return plan;
  }

  /** Run the engine and the CLI on twin repositories. */
  async function both(
    prepare: (root: string) => void,
    profile: string,
    onConflict: OnConflict
  ) {
    const roots = twins(prepare);
    const result = engine.output(
      planOf(profile),
      await readRepository(roots.engine),
      onConflict
    );
    const ran = compile(roots.cli, profile, onConflict);
    return { ran, result, roots };
  }

  /** Both write: applying the engine's output leaves the same tree, byte for byte, as the CLI's compile. */
  async function bothWrite(
    prepare: (root: string) => void,
    profile: string,
    onConflict: OnConflict
  ): Promise<RepositoryOutput> {
    const { ran, result, roots } = await both(prepare, profile, onConflict);
    expect(ran).toMatchObject({ status: 0 });
    if (!result.ok) {
      throw new Error(JSON.stringify(result.errors));
    }
    expect(result.value.refused).toStrictEqual([]);
    apply(roots.engine, result.value);
    expect(tree(roots.engine)).toStrictEqual(tree(roots.cli));
    return result.value;
  }

  it.each(["base", "minimal", "full"])(
    "writes %s into an empty repository",
    async (profile) => {
      const output = await bothWrite(
        (root) => {
          mkdirSync(root, { recursive: true });
        },
        profile,
        "fail"
      );
      expect(output.write.length).toBeGreaterThan(1);
    }
  );

  it("fails on a conflicting apm.yml under `fail`, as the CLI does", async () => {
    const { ran, result, roots } = await both(
      (root) => {
        writeFileSync(path.join(root, "apm.yml"), CONFLICTING);
      },
      "base",
      "fail"
    );
    expect(ran.status).toBe(1);
    expect(result.ok).toBeFalsy();
    const message = result.ok ? "" : (result.errors[0]?.message ?? "");
    expect(
      result.ok ? [] : result.errors.map((error) => error.path)
    ).toStrictEqual(["apm.yml"]);
    // The CLI names the file by its full path; the engine has only the repository's.
    expect(ran.stderr).toContain(
      message.replace(/^apm\.yml/u, path.join(roots.cli, "apm.yml"))
    );
  });

  it.each(["shelf-wins", "local-wins"] as const)(
    "merges a conflicting apm.yml under `%s`",
    async (onConflict) => {
      const output = await bothWrite(
        (root) => {
          writeFileSync(path.join(root, "apm.yml"), CONFLICTING);
        },
        "base",
        onConflict
      );
      expect(output.conflicts).toStrictEqual(["`targets`"]);
    }
  );

  it("removes a stale file from its own package, and only there", async () => {
    const output = await bothWrite(
      (root) => {
        expect(compile(root, "minimal", "fail")).toMatchObject({ status: 0 });
        writeFileSync(path.join(root, "vendor/minimal/.apm/stale.md"), "old\n");
        mkdirSync(path.join(root, "vendor/tools"));
        writeFileSync(path.join(root, "vendor/tools/tool.php"), "<?php\n");
      },
      "minimal",
      "fail"
    );
    expect(output.remove).toStrictEqual(["vendor/minimal/.apm/stale.md"]);
  });

  it("refuses an unowned vendor/<name> and removes nothing from it", async () => {
    const { ran, result, roots } = await both(
      (root) => {
        mkdirSync(path.join(root, "vendor/minimal/framework"), {
          recursive: true,
        });
        writeFileSync(
          path.join(root, "vendor/minimal/framework/App.php"),
          "<?php\n"
        );
      },
      "minimal",
      "fail"
    );
    expect(ran.status).toBe(1);
    expect(result.ok && result.value).toStrictEqual({
      conflicts: [],
      prune: [],
      refused: refusedLines(ran.stderr),
      remove: [],
      write: [],
    });
    expect(result.ok && result.value.refused[0]).toMatch(
      /^vendor\/minimal exists and is not a package ShelfKit vendored/u
    );
    expect(tree(roots.cli)).toStrictEqual(tree(roots.engine));
  });

  it("refuses a symbolic link it is told about, naming it as the CLI does", async () => {
    const outside = scratch();
    const { ran, result } = await both(
      (root) => {
        expect(compile(root, "minimal", "fail")).toMatchObject({ status: 0 });
        rmSync(path.join(root, "vendor/minimal/.apm"), { recursive: true });
        symlinkSync(outside, path.join(root, "vendor/minimal/.apm"));
      },
      "minimal",
      "fail"
    );
    expect(ran.status).toBe(1);
    expect(result.ok && result.value.refused).toStrictEqual(
      refusedLines(ran.stderr)
    );
    expect(result.ok && result.value.refused).toContain(
      "vendor/minimal/.apm is a symbolic link; ShelfKit never writes, creates, or deletes through one"
    );
    expect(readdirSync(outside)).toStrictEqual([]);
  });

  it("refuses a linked apm.yml", async () => {
    const outside = scratch();
    writeFileSync(path.join(outside, "precious.txt"), "precious\n");
    const { ran, result } = await both(
      (root) => {
        symlinkSync(
          path.join(outside, "precious.txt"),
          path.join(root, "apm.yml")
        );
      },
      "minimal",
      "fail"
    );
    expect(ran.status).toBe(1);
    expect(result.ok && result.value.refused).toStrictEqual(
      refusedLines(ran.stderr)
    );
  });

  it("prunes the directories a removal empties, as the CLI does", async () => {
    const output = await bothWrite(
      (root) => {
        expect(compile(root, "minimal", "fail")).toMatchObject({ status: 0 });
        mkdirSync(path.join(root, "vendor/minimal/.apm/skills/old/ref"), {
          recursive: true,
        });
        writeFileSync(
          path.join(root, "vendor/minimal/.apm/skills/old/SKILL.md"),
          "old\n"
        );
        writeFileSync(
          path.join(root, "vendor/minimal/.apm/skills/old/ref/a.md"),
          "old\n"
        );
      },
      "minimal",
      "fail"
    );
    expect(output.prune).toContain("vendor/minimal/.apm/skills/old/ref");
    expect(output.prune).toContain("vendor/minimal/.apm/skills/old");
  });

  it("refuses a root apm.yml that is not UTF-8, as the CLI does", async () => {
    const { ran, result, roots } = await both(
      (root) => {
        writeFileSync(path.join(root, "apm.yml"), NOT_UTF8);
      },
      "minimal",
      "fail"
    );
    expect(ran.status).toBe(1);
    expect(result.ok && result.value.refused).toStrictEqual(
      relativeLines(ran.stderr, roots.cli)
    );
    expect(tree(roots.engine)).toStrictEqual(tree(roots.cli));
  });

  it("never takes a package whose apm.yml is not UTF-8 for its own", async () => {
    const { ran, result, roots } = await both(
      (root) => {
        expect(compile(root, "minimal", "fail")).toMatchObject({ status: 0 });
        const manifest = path.join(root, "vendor/minimal/apm.yml");
        writeFileSync(
          manifest,
          // In a comment, so a lossy decode would still read the marker.
          Buffer.concat([readFileSync(manifest), Buffer.from("# "), NOT_UTF8])
        );
        writeFileSync(path.join(root, "vendor/minimal/keep-me.txt"), "mine\n");
      },
      "minimal",
      "fail"
    );
    expect(ran.status).toBe(1);
    expect(result.ok && result.value).toMatchObject({
      refused: relativeLines(ran.stderr, roots.cli),
      remove: [],
    });
    expect(tree(roots.engine)).toStrictEqual(tree(roots.cli));
  });

  it("reports a link inside an unowned package line for line with the CLI", async () => {
    const outside = scratch();
    const { ran, result } = await both(
      (root) => {
        mkdirSync(path.join(root, "vendor/minimal"), { recursive: true });
        symlinkSync(outside, path.join(root, "vendor/minimal/.apm"));
      },
      "minimal",
      "fail"
    );
    expect(ran.status).toBe(1);
    expect(refusedLines(ran.stderr)).toHaveLength(2);
    expect(result.ok && result.value.refused).toStrictEqual(
      refusedLines(ran.stderr)
    );
  });
});
