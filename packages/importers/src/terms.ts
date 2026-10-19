/**
 * The terms of each source ShelfKit imports from, as researched, with where they were read and when.
 *
 * An adapter applies its source's terms to every item it imports: the licence, whether content may be kept at all,
 * and the credit the source asks for. Terms change, so each entry records the page it was read from and the date;
 * re-read them before relying on an entry much older than its `checked` date.
 */
import type { Licence } from "./licence.ts";
import { fromSpdx, restrictive } from "./licence.ts";

export interface SourceTerms {
  /** The source, as people name it. */
  readonly name: string;
  /**
   * The licence that covers what the adapter imports from this source, or `"per-artifact"` when each artifact
   * carries its own (a Git repository's licence files, or skills.sh, which indexes repositories it does not
   * relicense).
   */
  readonly licence: Licence | "per-artifact";
  /** The credit the source asks for, as text, when it asks for one. */
  readonly creditText?: string;
  /** Where the credit links to. */
  readonly linkTarget?: string;
  /** The pages the terms were read from. */
  readonly citations: readonly string[];
  /** The date the citations were read, `YYYY-MM-DD`. */
  readonly checked: string;
  /** What the terms say, in one or two sentences. */
  readonly summary: string;
}

const CHECKED = "2026-10-19";

/** The official MCP Registry (`registry.modelcontextprotocol.io`). */
export const MCP_REGISTRY_TERMS: SourceTerms = {
  checked: CHECKED,
  citations: [
    "https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/terms-of-service.mdx",
    "https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/registry-aggregators.mdx",
  ],
  creditText: "This data comes from the Official MCP Registry",
  licence:
    fromSpdx(
      "CC0-1.0",
      "CC0-1.0: Registry Data is dedicated to the public domain (Official MCP Registry Terms of Service, section 10)"
    ) ?? restrictive("CC0-1.0", "CC0-1.0"),
  linkTarget: "https://registry.modelcontextprotocol.io",
  name: "Official MCP Registry",
  summary:
    "Server metadata (names, descriptions, URLs, identifiers) is dedicated to the public domain under CC0 1.0; the dedication does not cover the packages the metadata points to, which ShelfKit never copies. The branding clause allows saying the data comes from the Official MCP Registry, and aggregators are asked to read the API infrequently and keep each server's status current.",
};

/** ClawHub (`clawhub.ai`), the OpenClaw skill registry. */
export const CLAWHUB_TERMS: SourceTerms = {
  checked: CHECKED,
  citations: [
    "https://github.com/openclaw/clawhub/blob/main/docs/skill-format.md#license",
    "https://github.com/openclaw/clawhub/blob/main/docs/http-api.md#public-catalog-reuse",
  ],
  creditText: "Published on ClawHub",
  licence:
    fromSpdx(
      "MIT-0",
      "MIT-0: every skill published on ClawHub (ClawHub skill format, License)"
    ) ?? restrictive("MIT-0", "MIT-0"),
  linkTarget: "https://clawhub.ai",
  name: "ClawHub",
  summary:
    "All skills published on ClawHub are licensed MIT-0, with no per-skill override, and attribution is not required. Third parties reusing the public catalog are asked to link back to the canonical listing, https://clawhub.ai/<owner>/skills/<slug>, and not to mirror hidden or moderation-blocked content; ShelfKit records that listing as each item's record URL and link target.",
};

/** skills.sh, Vercel's skill directory, read here for its security audits. */
export const SKILLS_SH_TERMS: SourceTerms = {
  checked: CHECKED,
  citations: ["https://www.skills.sh/terms", "https://www.skills.sh/docs/api"],
  licence: "per-artifact",
  name: "skills.sh",
  summary:
    "Skills in the directory belong to their authors under the licences in their source repositories; skills.sh does not relicense them. The public API is rate-limited per IP, and caching results is allowed. Audits carry a provider and a timestamp but no content hash.",
};

/** `github/awesome-copilot`, read as a Git repository. */
export const AWESOME_COPILOT_TERMS: SourceTerms = {
  checked: CHECKED,
  citations: ["https://github.com/github/awesome-copilot/blob/main/LICENSE"],
  licence: "per-artifact",
  name: "awesome-copilot",
  summary:
    "The repository is MIT-licensed (its LICENSE file, which GitHub reports as MIT), so its prompts, instructions, agents, and skills import with content and the MIT attribution notice obligation.",
};

/** Any Git repository: the licence is the artifact's own licence file, else the repository's. */
export const GIT_TERMS: SourceTerms = {
  checked: CHECKED,
  citations: ["https://docs.github.com/en/rest/licenses/licenses"],
  licence: "per-artifact",
  name: "Git repository",
  summary:
    "The nearest licence file to the artifact decides (a skill's own LICENSE.txt over the repository's), then the repository licence GitHub detects, then SKILL.md's `license` field when it names an SPDX licence. With none of these, or one ShelfKit cannot identify as permitting copies, the import is link-only.",
};

/** Another ShelfKit instance. */
export const SHELFKIT_TERMS: SourceTerms = {
  checked: CHECKED,
  citations: ["docs/PRD.md section 7.2"],
  licence: "per-artifact",
  name: "ShelfKit instance",
  summary:
    "An instance states no licence for the items authored on it, so they import as links. Items it imported itself carry their own licence in `source`, which travels with them. A public profile imports as a reference to the instance's registry package, which copies nothing.",
};

/** Every source's terms, for documentation and the licence table. */
export const ALL_TERMS: readonly SourceTerms[] = [
  GIT_TERMS,
  MCP_REGISTRY_TERMS,
  AWESOME_COPILOT_TERMS,
  CLAWHUB_TERMS,
  SKILLS_SH_TERMS,
  SHELFKIT_TERMS,
];
