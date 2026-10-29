import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  Engine,
  EngineResult,
  GitCommitRequest,
  GitCommitted,
  GitReport,
  GitSignature,
} from "../src/index.ts";
import { loadEngine } from "../src/node.ts";

const author: GitSignature = {
  email: "test@shelfkit.invalid",
  name: "ShelfKit Test",
  offset: 420,
  time: 1_760_000_000,
};

const ZERO = "0".repeat(40);

/** `git` with no user or system configuration; its result, whatever the exit code. */
function git(cwd: string, args: readonly string[], input?: Uint8Array) {
  return spawnSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
    },
    input,
  });
}

const hasGit = spawnSync("git", ["--version"]).status === 0;
if (!hasGit) {
  console.warn(
    "skipping the tests that push to a real repository: no `git` on PATH"
  );
}

function answered<T>(result: EngineResult<T>): T {
  if (!result.ok) {
    throw new Error(JSON.stringify(result.errors));
  }
  return result.value;
}

/** A pkt-line: four hex digits of length, then the data. */
function pkt(line: string): string {
  return `${(new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;
}

function committed(engine: Engine, request: GitCommitRequest): GitCommitted {
  const plan = answered(engine.gitCommit(request));
  if (plan.unchanged) {
    throw new Error("the plan is unchanged");
  }
  return plan;
}

describe("git", () => {
  let engine: Engine;
  beforeAll(async () => {
    engine = await loadEngine();
  });

  describe("a root commit", () => {
    let plan: GitCommitted;
    beforeAll(() => {
      plan = committed(engine, {
        author,
        base: [],
        files: [
          { contents: "{}\n", path: "shelf.json" },
          {
            contents: new Uint8Array([0, 255, 1]),
            mode: "100755",
            path: "bin/tool",
          },
        ],
        message: "Create the shelf",
      });
    });

    it("packs the commit, two trees, and two blobs", () => {
      expect(plan.objects).toBe(5);
      expect(plan.files.map((file) => file.mode)).toStrictEqual([
        "100644",
        "100755",
      ]);
    });

    it("creates the reference, asking for report-status", () => {
      const request = new TextDecoder().decode(plan.request);
      const length = Number.parseInt(request.slice(0, 4), 16);
      const [update = "", capabilities = ""] = request
        .slice(4, length)
        .split("\0");
      expect(update).toBe(`${ZERO} ${plan.commit} refs/heads/main`);
      expect(capabilities.split(" ")[0]).toBe("report-status");
      expect(request.slice(length, length + 8)).toBe("0000PACK");
    });
  });

  it("reports the parent's own files as unchanged", () => {
    const first = committed(engine, {
      author,
      base: [],
      files: [{ contents: "a\n", path: "a.md" }],
      message: "One",
    });
    const again = engine.gitCommit({
      author,
      base: first.files,
      files: [{ id: first.files[0]?.id ?? "", path: "a.md" }],
      message: "Two",
      parent: first.commit,
    });
    expect(again).toStrictEqual({
      ok: true,
      value: {
        commit: null,
        files: first.files,
        objects: 0,
        request: null,
        tree: first.tree,
        unchanged: true,
      },
    });
  });

  it("keeps a gitlink by id, packing nothing for it", () => {
    const submodule = "1".repeat(40);
    const plan = committed(engine, {
      author,
      base: [],
      files: [{ id: submodule, mode: "160000", path: "vendor/sub" }],
      message: "Submodule",
    });
    // The commit, the root, and `vendor`.
    expect(plan.objects).toBe(3);
  });

  it("names the path of each invalid file", () => {
    const result = engine.gitCommit({
      author,
      base: [],
      files: [
        { contents: "", path: ".git/config" },
        { id: "a".repeat(40), path: "elsewhere.md" },
      ],
      message: "Bad",
    });
    expect(
      result.ok ? [] : result.errors.map((error) => error.path)
    ).toStrictEqual(["elsewhere.md", ".git/config"]);
  });

  it("throws on a malformed request", () => {
    expect(() =>
      engine.gitCommit({
        author,
        base: [],
        files: [],
        message: "",
        parent: "nope",
      })
    ).toThrow(/parent/u);
  });

  it("reads a ref advertisement, and refuses what is not one", () => {
    const [one, two] = ["1".repeat(40), "2".repeat(40)];
    const body = new TextEncoder().encode(
      [
        pkt("# service=git-upload-pack\n"),
        "0000",
        pkt(`${one} HEAD\0symref=HEAD:refs/heads/main agent=git/2\n`),
        pkt(`${one} refs/heads/main\n`),
        pkt(`${two} refs/tags/v1.0.0\n`),
        pkt(`${one} refs/tags/v1.0.0^{}\n`),
        "0000",
      ].join("")
    );
    expect(engine.gitRefs(body)).toStrictEqual({
      ok: true,
      value: {
        capabilities: ["symref=HEAD:refs/heads/main", "agent=git/2"],
        refs: [
          { id: one, name: "HEAD" },
          { id: one, name: "refs/heads/main" },
          { id: two, name: "refs/tags/v1.0.0", peeled: one },
        ],
      },
    });
    const refused = engine.gitRefs(new TextEncoder().encode("0000PACK"));
    expect(
      refused.ok ? [] : refused.errors.map((error) => error.path)
    ).toStrictEqual(["advertisement"]);
  });

  it("reads a report, and refuses what is not one", () => {
    const body = new TextEncoder().encode(
      "000eunpack ok\n0017ok refs/heads/main\n0025ng refs/heads/x non-fast-forward\n0000"
    );
    expect(engine.gitReport(body)).toStrictEqual({
      ok: true,
      value: {
        refs: [
          { name: "refs/heads/main", ok: true },
          { name: "refs/heads/x", ok: false, reason: "non-fast-forward" },
        ],
        unpack: { ok: true },
      },
    });
    expect(
      engine.gitReport(new TextEncoder().encode("nonsense")).ok
    ).toBeFalsy();
  });

  describe.skipIf(!hasGit)("against a real repository", () => {
    let directory = "";
    let repo = "";
    let first: GitCommitted;

    /** Push a request with `git receive-pack`, and read its report. */
    function push(request: Uint8Array): GitReport {
      const pushed = git(
        repo,
        ["receive-pack", "--stateless-rpc", "."],
        request
      );
      if (pushed.status !== 0) {
        throw new Error(pushed.stderr.toString());
      }
      return answered(engine.gitReport(pushed.stdout));
    }

    beforeAll(() => {
      directory = mkdtempSync(path.join(tmpdir(), "shelfkit-engine-git-"));
      git(directory, [
        "init",
        "--bare",
        "--quiet",
        "--initial-branch=main",
        "repo",
      ]);
      repo = path.join(directory, "repo");
      first = committed(engine, {
        author,
        base: [],
        files: [
          {
            contents: new Uint8Array([0, 255, 1]),
            mode: "100755",
            path: "bin/tool",
          },
          { contents: "Say hi.\n", path: "items/prompts/hi/prompt.md" },
          { contents: "shelf.json", mode: "120000", path: "link" },
          { contents: "{}\n", path: "shelf.json" },
          { id: "2".repeat(40), mode: "160000", path: "vendor/sub" },
        ],
        message: "Create",
      });
    });

    afterAll(() => {
      rmSync(directory, { force: true, recursive: true });
    });

    it("applies a root commit, every byte and mode as given", () => {
      expect(push(first.request)).toStrictEqual({
        refs: [{ name: "refs/heads/main", ok: true }],
        unpack: { ok: true },
      });
      expect(git(repo, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);
      const tool = git(repo, ["cat-file", "blob", "refs/heads/main:bin/tool"]);
      expect(new Uint8Array(tool.stdout)).toStrictEqual(
        new Uint8Array([0, 255, 1])
      );
      const listed = git(repo, ["ls-tree", "refs/heads/main", "bin/tool"]);
      expect(listed.stdout.toString()).toMatch(/^100755 blob /u);
      const shown = git(repo, ["log", "--format=%an <%ae> %at%n%B", "-1"]);
      expect(shown.stdout.toString()).toBe(
        `${author.name} <${author.email}> ${author.time}\nCreate\n\n`
      );
    });

    it("applies a change on top, keeping the gitlink", () => {
      const second = committed(engine, {
        author,
        base: first.files,
        files: [
          { contents: "Say hello.\n", path: "items/prompts/hi/prompt.md" },
          { contents: "{}\n", path: "shelf.json" },
          { id: "2".repeat(40), mode: "160000", path: "vendor/sub" },
        ],
        message: "Edit",
        parent: first.commit,
      });
      expect(push(second.request).refs).toStrictEqual([
        { name: "refs/heads/main", ok: true },
      ]);
      expect(git(repo, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);
      const listed = git(repo, ["ls-tree", "-r", "refs/heads/main"]);
      expect(listed.stdout.toString()).toContain(
        `160000 commit ${"2".repeat(40)}\tvendor/sub\n`
      );
      const shown = git(repo, [
        "show",
        "refs/heads/main:items/prompts/hi/prompt.md",
      ]);
      expect(shown.stdout.toString()).toBe("Say hello.\n");
    });

    it("reports a push from a stale parent as refused for its reference", () => {
      const stale = committed(engine, {
        author,
        base: first.files,
        files: [{ contents: "x\n", path: "x.md" }],
        message: "Stale",
        parent: first.commit,
      });
      const report = push(stale.request);
      expect(report.unpack.ok).toBeTruthy();
      expect(report.refs[0]?.ok).toBeFalsy();
    });

    it("reads the references the repository advertises", () => {
      const advertised = git(repo, [
        "upload-pack",
        "--stateless-rpc",
        "--advertise-refs",
        ".",
      ]);
      const main = git(repo, ["rev-parse", "refs/heads/main"])
        .stdout.toString()
        .trim();
      expect(answered(engine.gitRefs(advertised.stdout)).refs).toStrictEqual([
        { id: main, name: "HEAD" },
        { id: main, name: "refs/heads/main" },
      ]);
    });
  });
});
