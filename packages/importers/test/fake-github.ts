/**
 * A hand-written GitHub for the git adapter's tests: the endpoints the adapter reads (`../src/github.ts`), answering
 * from a map of commits to files, so a test says exactly what each file holds at each commit.
 */
export type Commits = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

/**
 * A fake GitHub for `acme/kit`: `main` is the last commit; every tree's SHA is `<commit>:<directory>`. A path in
 * `symlinks` is listed as a symbolic link (mode `120000`), as GitHub lists one.
 */
export function fakeGitHub(
  commits: Commits,
  head: string,
  symlinks: readonly string[] = []
): typeof fetch {
  const listing = (commit: string, directory: string, recursive: boolean) => {
    const files = Object.keys(commits[commit] ?? {});
    const prefix = directory === "" ? "" : `${directory}/`;
    const entries = new Map<
      string,
      { mode: string; path: string; sha: string; type: string; size: number }
    >();
    for (const file of files.filter((path) => path.startsWith(prefix))) {
      const rest = file.slice(prefix.length);
      const [first = ""] = rest.split("/");
      if (recursive || !rest.includes("/")) {
        entries.set(rest, {
          mode: symlinks.includes(file) ? "120000" : "100644",
          path: rest,
          sha: `${commit}:${file}`,
          size: 1,
          type: "blob",
        });
      } else {
        entries.set(first, {
          mode: "040000",
          path: first,
          sha: `${commit}:${prefix}${first}`,
          size: 0,
          type: "tree",
        });
      }
    }
    return { sha: `${commit}:${directory}`, tree: [...entries.values()] };
  };
  /** A file's text at a commit, as `raw` or `/contents` serves it. */
  const file = (
    commit: string | undefined,
    path: string | undefined
  ): Response => {
    const text = commits[commit ?? ""]?.[decodeURIComponent(path ?? "")];
    return text === undefined
      ? new Response("", { status: 404 })
      : new Response(text);
  };
  return async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    const routes: [
      RegExp,
      (groups: Record<string, string | undefined>) => Response,
    ][] = [
      [
        /^https:\/\/api\.github\.com\/repos\/acme\/kit$/u,
        () => Response.json({ default_branch: "main" }),
      ],
      [/\/commits\/main$/u, () => Response.json({ sha: head })],
      [
        /\/git\/trees\/(?<sha>[^?]+)(?<recursive>\?recursive=1)?$/u,
        (groups) => {
          const [commit = "", directory = ""] = decodeURIComponent(
            groups.sha ?? ""
          ).split(":");
          return Response.json(
            listing(commit, directory, groups.recursive !== undefined)
          );
        },
      ],
      [
        /\/contents\/(?<path>[^?]+)\?ref=(?<commit>.+)$/u,
        (groups) => file(groups.commit, groups.path),
      ],
      [
        /^https:\/\/raw\.githubusercontent\.com\/acme\/kit\/(?<commit>[^/]+)\/(?<path>.+)$/u,
        (groups) => file(groups.commit, groups.path),
      ],
    ];
    const routed = routes
      .map(([pattern, answer]) => ({ answer, match: pattern.exec(url) }))
      .find(({ match }) => match !== null);
    const response =
      routed === undefined
        ? new Response("", { status: 404 })
        : routed.answer(routed.match?.groups ?? {});
    return await Promise.resolve(response);
  };
}
