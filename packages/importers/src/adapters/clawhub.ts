/**
 * ClawHub (`clawhub.ai`): skills published to the OpenClaw registry, pinned to a version.
 *
 * Every skill on ClawHub is MIT-0 (`../terms.ts`), so its files are copied. Each file is checked against the sha256
 * ClawHub lists for the version before it is kept: a copy that differs from what ClawHub published (and scanned) is
 * an error, not an import. Each item records the canonical listing, `https://clawhub.ai/<owner>/skills/<slug>`, as
 * its record URL and link target, as ClawHub asks of catalog reuse. A malware-blocked skill is never offered.
 *
 * A source's `path` is `owner/slug` (or `@owner/slug`) for one skill, or a search term.
 */
import * as v from "valibot";

import { frontmatter, skillProblem } from "../frontmatter.ts";
import {
  byCodePoint,
  fileContents,
  getBytes,
  getJson,
  sha256Hex,
} from "../http.ts";
import { kebab, uniqueIds } from "../ids.ts";
import {
  importedItem,
  linkOnlyWarning,
  provenance,
  sourceOf,
} from "../imported.ts";
import { licenceFields } from "../licence.ts";
import type { LicenceFields } from "../licence.ts";
import type {
  AdapterContext,
  Candidate,
  Discovery,
  ImportedFile,
  ImportedItem,
  ImportSource,
  Item,
  Pick,
  UpstreamState,
} from "../seam.ts";
import { CLAWHUB_TERMS } from "../terms.ts";

export const CLAWHUB = "https://clawhub.ai";

const SkillSchema = v.object({
  latestVersion: v.nullish(v.object({ version: v.string() })),
  moderation: v.nullish(
    v.object({
      isMalwareBlocked: v.optional(v.boolean()),
      isSuspicious: v.optional(v.boolean()),
    })
  ),
  skill: v.object({
    displayName: v.optional(v.string()),
    slug: v.string(),
    summary: v.nullish(v.string()),
  }),
});

type Skill = v.InferOutput<typeof SkillSchema>;

const SearchSchema = v.object({
  results: v.array(
    v.object({ ownerHandle: v.nullish(v.string()), slug: v.string() })
  ),
});

export const VersionSchema = v.object({
  version: v.object({
    files: v.array(
      v.object({
        path: v.string(),
        sha256: v.string(),
        size: v.optional(v.number()),
      })
    ),
    security: v.nullish(
      v.object({
        checkedAt: v.nullish(v.number()),
        hasScanResult: v.optional(v.boolean()),
        sha256hash: v.nullish(v.string()),
        status: v.optional(v.string()),
      })
    ),
    version: v.string(),
  }),
});

type Published = v.InferOutput<typeof VersionSchema>["version"];

/** A skill on ClawHub: its publisher and its slug. */
export interface SkillRef {
  readonly owner: string;
  readonly slug: string;
}

export function isClawHub(url: string): boolean {
  const { hostname, protocol } = new URL(url);
  return (
    protocol === "https:" &&
    (hostname === "clawhub.ai" || hostname.endsWith(".clawhub.ai"))
  );
}

/** A ClawHub skill version is copied only up to this many files and bytes. */
const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;

/** `owner/slug` (or `@owner/slug`), or `undefined` for a search term. */
function skillRef(path: string): SkillRef | undefined {
  const groups = /^@?(?<owner>[\w.-]+)\/(?<slug>[\w.-]+)$/u.exec(
    path.trim()
  )?.groups;
  const owner = groups?.owner;
  const slug = groups?.slug;
  return owner === undefined || slug === undefined
    ? undefined
    : { owner, slug };
}

function api(path: string): string {
  return `${CLAWHUB}/api/v1${path}`;
}

function owned(owner: string): string {
  return `ownerHandle=${encodeURIComponent(owner)}`;
}

/** The canonical listing ClawHub asks reusers to link to. */
export function listingUrl(owner: string, slug: string): string {
  return `${CLAWHUB}/${owner}/skills/${slug}`;
}

export function versionUrl(
  owner: string,
  slug: string,
  version: string
): string {
  return api(
    `/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}?${owned(owner)}`
  );
}

function fileUrl(ref: SkillRef, version: string, path: string): string {
  const query = `path=${encodeURIComponent(path)}&version=${encodeURIComponent(version)}&${owned(ref.owner)}`;
  return api(`/skills/${encodeURIComponent(ref.slug)}/file?${query}`);
}

async function skill(
  context: AdapterContext,
  ref: SkillRef
): Promise<Skill | null> {
  return await getJson(
    context.fetch,
    api(`/skills/${encodeURIComponent(ref.slug)}?${owned(ref.owner)}`),
    SkillSchema
  );
}

/** ClawHub's licence for every skill, as `source` fields. */
function clawHubLicence(): LicenceFields {
  const terms = CLAWHUB_TERMS.licence;
  return terms === "per-artifact"
    ? { license: "MIT-0", licenseId: "MIT-0", shareAlike: false }
    : licenceFields(terms);
}

/** The skills a source names: one by `owner/slug`, or the first ten a search finds. */
async function named(
  source: ImportSource,
  context: AdapterContext
): Promise<SkillRef[]> {
  const query = source.path?.trim() ?? "";
  if (query === "") {
    throw new Error(
      "name a skill as `owner/slug`, or a search term, in `path`"
    );
  }
  const one = skillRef(query);
  if (one !== undefined) {
    return [one];
  }
  const found = await getJson(
    context.fetch,
    api(
      `/search?q=${encodeURIComponent(query)}&limit=10&nonSuspiciousOnly=true`
    ),
    SearchSchema
  );
  return (found?.results ?? []).flatMap((result) =>
    result.ownerHandle === undefined || result.ownerHandle === null
      ? []
      : [{ owner: result.ownerHandle, slug: result.slug }]
  );
}

/** Why a skill is not offered, or `undefined` when it is. */
function refusal(ref: SkillRef, detail: Skill | null): string | undefined {
  const listing = listingUrl(ref.owner, ref.slug);
  if (detail === null) {
    return `${listing} is not there`;
  }
  if (detail.moderation?.isMalwareBlocked === true) {
    return `${listing} is malware-blocked on ClawHub and is not offered`;
  }
  if (detail.latestVersion === undefined || detail.latestVersion === null) {
    return `${listing} has no public version`;
  }
  return undefined;
}

export async function discoverClawHub(
  source: ImportSource,
  context: AdapterContext
): Promise<Discovery> {
  const refs = await named(source, context);
  const details = await Promise.all(
    refs.map(async (ref) => await skill(context, ref))
  );
  const warnings: string[] = [];
  const offered: { ref: SkillRef; detail: Skill; version: string }[] = [];
  for (const [index, ref] of refs.entries()) {
    const detail = details[index] ?? null;
    const refused = refusal(ref, detail);
    const version = detail?.latestVersion?.version;
    if (refused !== undefined || detail === null || version === undefined) {
      warnings.push(
        refused ?? `${listingUrl(ref.owner, ref.slug)} is not there`
      );
      continue;
    }
    if (detail.moderation?.isSuspicious === true) {
      warnings.push(
        `${listingUrl(ref.owner, ref.slug)} is flagged suspicious on ClawHub`
      );
    }
    offered.push({ detail, ref, version });
  }
  const licence = clawHubLicence();
  const ids = uniqueIds(
    offered.map(({ ref }) => ({ name: ref.slug, qualifier: kebab(ref.owner) }))
  );
  const candidates = offered.map(({ detail, ref, version }, index) => {
    const candidate: Candidate = {
      id: ids[index] ?? "skill",
      key: `${ref.owner}/${ref.slug}`,
      kind: "skill",
      license: licence.license,
      licenseId: licence.licenseId ?? "MIT-0",
      linkOnly: false,
      path: `${ref.owner}/${ref.slug}`,
      title: detail.skill.displayName ?? ref.slug,
      upstream: { url: listingUrl(ref.owner, ref.slug), version },
    };
    const { summary } = detail.skill;
    if (summary !== undefined && summary !== null) {
      candidate.description = summary;
    }
    return candidate;
  });
  return { candidates, warnings };
}

/** Download every file of a published version, refusing any whose bytes are not the sha256 ClawHub lists. */
async function download(
  context: AdapterContext,
  ref: SkillRef,
  published: Published
): Promise<ImportedFile[]> {
  const listed = published.files.toSorted((a, b) =>
    byCodePoint(a.path, b.path)
  );
  const declared = listed.reduce((sum, file) => sum + (file.size ?? 0), 0);
  if (listed.length > MAX_FILES || declared > MAX_BYTES) {
    throw new Error(
      `${listingUrl(ref.owner, ref.slug)}@${published.version} lists ${listed.length} files and ${declared} bytes, more than ShelfKit copies`
    );
  }
  return await Promise.all(
    listed.map(async (file) => {
      const url = fileUrl(ref, published.version, file.path);
      const bytes = await getBytes(context.fetch, url, { maxBytes: MAX_BYTES });
      if (bytes === null) {
        throw new Error(`${url}: listed in the version but not served`);
      }
      const digest = await sha256Hex(bytes);
      if (digest !== file.sha256.toLowerCase()) {
        throw new Error(
          `${url}: sha256 ${digest} is not the ${file.sha256} ClawHub lists for it`
        );
      }
      return { ...fileContents(bytes), path: file.path };
    })
  );
}

/** Why a downloaded skill cannot be kept as content, or `undefined` when it can. */
function contentProblem(
  files: readonly ImportedFile[],
  id: string
): string | undefined {
  const main = files.find((file) => file.path === "SKILL.md");
  if (main === undefined || main.encoding !== "utf-8") {
    return "it has no SKILL.md";
  }
  if (files.some((file) => file.path === "item.json")) {
    return "it has its own item.json, which the shelf's item.json would replace";
  }
  return skillProblem(main.contents, id);
}

export async function fetchClawHub(
  source: ImportSource,
  candidate: Candidate,
  pick: Pick,
  context: AdapterContext
): Promise<ImportedItem> {
  const ref = skillRef(candidate.key);
  if (ref === undefined) {
    throw new Error(
      `\`${candidate.key}\` is not a ClawHub skill as owner/slug`
    );
  }
  const listing = listingUrl(ref.owner, ref.slug);
  const version = pick.pin?.version ?? candidate.upstream.version ?? "";
  if (version === "") {
    throw new Error(`${listing}: no version to pin`);
  }
  const url = versionUrl(ref.owner, ref.slug, version);
  const found = await getJson(context.fetch, url, VersionSchema);
  if (found === null) {
    throw new Error(`${url}: ClawHub has no such version`);
  }
  const published = found.version;
  const files = await download(context, ref, published);
  const id = pick.id ?? candidate.id;
  const problem = contentProblem(files, id);
  const main = files.find((file) => file.path === "SKILL.md");
  const meta = frontmatter(main?.encoding === "utf-8" ? main.contents : "");
  const bundle = published.security?.sha256hash ?? undefined;
  const item = {
    description: meta.description ?? candidate.description,
    id,
    kind: "skill",
    source: provenance({
      ...clawHubLicence(),
      creditText: `${CLAWHUB_TERMS.creditText ?? "Published on ClawHub"} by @${ref.owner}`,
      digest:
        bundle === undefined ? undefined : `sha256:${bundle.toLowerCase()}`,
      id: source.sourceId,
      linkTarget: listing,
      path: `${ref.owner}/${ref.slug}`,
      recordUrl: listing,
      url: listing,
      version: published.version,
    }),
    title: candidate.title,
  };
  return importedItem({
    files,
    item,
    linkOnly: problem !== undefined,
    warnings:
      problem === undefined ? [] : [linkOnlyWarning(id, problem, listing)],
  });
}

/** The `owner/slug` of an item imported from ClawHub. */
export function clawHubRef(item: Item): SkillRef | undefined {
  const source = sourceOf(item);
  if (
    source.url === undefined ||
    !isClawHub(source.url) ||
    source.path === undefined
  ) {
    return undefined;
  }
  return skillRef(source.path);
}

export async function checkClawHub(
  item: Item,
  context: AdapterContext
): Promise<UpstreamState> {
  const ref = clawHubRef(item);
  if (ref === undefined) {
    return { error: "the item names no ClawHub skill", status: "error" };
  }
  const detail = await skill(context, ref);
  if (detail === null) {
    return { status: "gone" };
  }
  const version = detail.latestVersion?.version;
  const latest = { url: listingUrl(ref.owner, ref.slug), version };
  if (detail.moderation?.isMalwareBlocked === true) {
    return {
      error: "ClawHub blocks the skill as malware",
      latest,
      status: "gone",
    };
  }
  return {
    latest,
    status: version === sourceOf(item).version ? "current" : "moved",
  };
}
