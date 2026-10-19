# @shelfkit/importers

Source adapters and scanners behind the interface the Worker's import, upstream-check, and scan jobs call (`src/seam.ts`). `docs/PRD.md` sections 6, 7.2, and 11 define what they do.

| Kind | Reads | Adapter |
| --- | --- | --- |
| `git` | A GitHub repository, by APM's package layouts (`github/awesome-copilot` included) | `src/adapters/git.ts` |
| `catalog` | The official MCP Registry (or any https registry serving its API), and ClawHub | `src/adapters/catalog.ts` |
| `shelfkit` | Another ShelfKit instance's public profiles and items, over https | `src/adapters/shelfkit.ts` |

The scanners are ShelfKit's own (`src/scanners/static.ts`) and ClawHub's verdict (`src/scanners/clawhub.ts`). ClawHub's verdict is taken only when every file matches the sha256 that ClawHub lists for the version.

skills.sh's audits are not used. They name no commit or hash of what they judged, so a verdict could not be bound to the bytes ShelfKit holds.

## Licences

Each source's terms, with the pages they were read from and the date, are data in `src/terms.ts`.

### Which licences permit copies

- An artifact is copied only when ShelfKit identifies its licence as one on the permissive allowlist in `src/licence.ts`. The licence can be identified in three ways:
  - a licence file whose text is that licence's full text;
  - an `SPDX-License-Identifier` header;
  - a SKILL.md `license` that names an allowlisted SPDX id.
- Everything else imports as a link, with a warning:
  - no licence;
  - an unrecognised text;
  - NonCommercial or NoDerivatives terms;
  - source-available licences;
  - `LicenseRef-` identifiers;
  - proprietary notices.
- A link keeps provenance and the fields its kind cannot be without, such as an MCP server's endpoint. It keeps no text and no files.

### When the licence is read

- For a Git artifact, the licence is read from the files at the exact commit being copied, every time.
- A copy whose licence requires its notice gets the upstream licence file beside it, under its upstream name.

## A private GitHub repository

The importer reads GitHub only through `https://api.github.com`. It sends a token there and nowhere else.

To import from a private repository, or to check its drift:

1. Store the token as a Worker secret: `wrangler secret put SHELFKIT_SECRET_<NAME>`.
2. Bind the secret name to `https://api.github.com`, with `putSecretName(shelf, "<NAME>", "https://api.github.com", …)`.
3. Declare the source in `shelf.json` with the repository, the secret, and `url` set to that origin:

```json
{
  "id": "acme",
  "kind": "git",
  "repo": "https://github.com/acme/private-kit",
  "url": "https://api.github.com",
  "secret": "ACME_GITHUB_TOKEN"
}
```

Items imported from the source name it in `source.id`, and the hourly drift check uses the same secret.

A secret bound to `https://github.com` is never sent to the API. The import fails, and the drift check records an `error`, saying how to bind it.

## Recorded responses

The tests run against answers the real APIs gave, in `test/fixtures/http/`. `crates/compiler/tests/curation.rs` replays the same files for `shelfkit doctor`, and so does the Worker's `test/curation.test.ts`.

Of content that imports as a link, a recording keeps only what the adapter reads (its frontmatter).

To record again, run one test file at a time with `SHELFKIT_RECORD=1`. Set `SHELFKIT_RECORD_GITHUB_TOKEN=$(gh auth token)` past GitHub's anonymous rate limit; that token is sent to api.github.com only and is never stored.

`test/curated-shelf.test.ts` builds `test/fixtures/curated-shelf/`, M4's exit criterion. Regenerate it with `SHELFKIT_UPDATE_GOLDEN=1`.
