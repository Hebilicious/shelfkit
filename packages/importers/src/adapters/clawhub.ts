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

import { frontmatter, skillProblem, stringField } from "../frontmatter.ts";
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

const ModerationSchema = v.nullish(
  v.object({
    isMalwareBlocked: v.optional(v.boolean()),
    isSuspicious: v.optional(v.boolean()),
  })
);

const SkillSchema = v.object({
  latestVersion: v.nullish(v.object({ version: v.string() })),
  moderation: ModerationSchema,
  owner: v.nullish(v.object({ handle: v.string() })),
  skill: v.object({
    displayName: v.optional(v.string()),
    slug: v.string(),
    summary: v.nullish(v.string()),
  }),
});

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

export function isClawHub(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "clawhub.ai" || host.endsWith(".clawhub.ai");
}

/** `owner/slug` (or `@owner/slug`), or `undefined` for a search term. */
function skillRef(path: string): { owner: string; slug: string } | undefined {
  const match = /^@?([\w.-]+)\/([\w.-]+)$/u.exec(path.trim());
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { owner: match[1], slug: match[2] };
}

const api = (path: string): string => `${CLAWHUB}/api/v1${path}`;

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

async function skill(
  context: AdapterContext,
  owner: string,
  slug: string
): Promise<v.InferOutput<typeof SkillSchema> | null> {
  const found = await getJson(
    context.fetch,
    api(`/skills/${encodeURIComponent(slug)}?${owned(owner)}`)
  );
  return found === null ? null : v.parse(SkillSchema, found);
}

export async function discoverClawHub(
  source: ImportSource,
  context: AdapterContext
): Promise<Discovery> {
  const query = source.path?.trim() ?? "";
  if (query === "") {
    throw new Error(
      "name a skill as `owner/slug`, or a search term, in `path`"
    );
  }
  const one = skillRef(query);
  const refs: { owner: string; slug: string }[] = [];
  if (one === undefined) {
    const found = v.parse(
      SearchSchema,
      await getJson(
        context.fetch,
        api(
          `/search?q=${encodeURIComponent(query)}&limit=10&nonSuspiciousOnly=true`
        )
      )
    );
    for (const result of found.results) {
      if (result.ownerHandle !== undefined && result.ownerHandle !== null) {
        refs.push({ owner: result.ownerHandle, slug: result.slug });
      }
    }
  } else {
    refs.push(one);
  }
  const warnings: string[] = [];
  const offered: {
    owner: string;
    slug: string;
    detail: v.InferOutput<typeof SkillSchema>;
  }[] = [];
  for (const ref of refs) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- at most ten, in turn, to respect ClawHub's rate limits.
    const detail = await skill(context, ref.owner, ref.slug);
    if (detail === null) {
      warnings.push(`${listingUrl(ref.owner, ref.slug)} is not there`);
    } else if (detail.moderation?.isMalwareBlocked === true) {
      warnings.push(
        `${listingUrl(ref.owner, ref.slug)} is malware-blocked on ClawHub and is not offered`
      );
    } else if (
      detail.latestVersion === undefined ||
      detail.latestVersion === null
    ) {
      warnings.push(`${listingUrl(ref.owner, ref.slug)} has no public version`);
    } else {
      if (detail.moderation?.isSuspicious === true) {
        warnings.push(
          `${listingUrl(ref.owner, ref.slug)} is flagged suspicious on ClawHub`
        );
      }
      offered.push({ ...ref, detail });
    }
  }
  const licence =
    CLAWHUB_TERMS.licence === "per-artifact"
      ? undefined
      : CLAWHUB_TERMS.licence;
  const ids = uniqueIds(
    offered.map((entry) => ({
      name: entry.slug,
      qualifier: kebab(entry.owner),
    }))
  );
  const candidates: Candidate[] = offered.map((entry, index) => ({
    ...(entry.detail.skill.summary === undefined ||
    entry.detail.skill.summary === null
      ? {}
      : { description: entry.detail.skill.summary }),
    id: ids[index] ?? "skill",
    key: `${entry.owner}/${entry.slug}`,
    kind: "skill",
    license: licence?.statement ?? "MIT-0",
    licenseId: licence?.id ?? "MIT-0",
    linkOnly: false,
    path: `${entry.owner}/${entry.slug}`,
    title: entry.detail.skill.displayName ?? entry.slug,
    upstream: {
      url: listingUrl(entry.owner, entry.slug),
      version: entry.detail.latestVersion?.version ?? "",
    },
  }));
  return { candidates, warnings };
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
  const version = pick.pin?.version ?? candidate.upstream.version;
  if (version === undefined || version === "") {
    throw new Error(`${listingUrl(ref.owner, ref.slug)}: no version to pin`);
  }
  const url = versionUrl(ref.owner, ref.slug, version);
  const found = await getJson(context.fetch, url);
  if (found === null) {
    throw new Error(`${url}: ClawHub has no such version`);
  }
  const published = v.parse(VersionSchema, found).version;
  const files: ImportedFile[] = [];
  for (const listed of published.files.toSorted((a, b) =>
    byCodePoint(a.path, b.path)
  )) {
    const fileUrl = api(
      `/skills/${encodeURIComponent(ref.slug)}/file?path=${encodeURIComponent(listed.path)}&version=${encodeURIComponent(
        published.version
      )}&${owned(ref.owner)}`
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- one file at a time, within ClawHub's download limits.
    const bytes = await getBytes(context.fetch, fileUrl);
    if (bytes === null) {
      throw new Error(`${fileUrl}: listed in the version but not served`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- hashed as it arrives.
    const digest = await sha256Hex(bytes);
    if (digest !== listed.sha256.toLowerCase()) {
      throw new Error(
        `${fileUrl}: sha256 ${digest} is not the ${listed.sha256} ClawHub lists for it`
      );
    }
    files.push({ ...fileContents(bytes), path: listed.path });
  }
  const id = pick.id ?? candidate.id;
  const listing = listingUrl(ref.owner, ref.slug);
  const main = files.find((file) => file.path === "SKILL.md");
  const problem =
    main === undefined || main.encoding !== "utf-8"
      ? "it has no SKILL.md"
      : files.some((file) => file.path === "item.json")
        ? "it has its own item.json, which the shelf's item.json would replace"
        : skillProblem(main.contents, id);
  const meta =
    main?.encoding === "utf-8" ? frontmatter(main.contents) : undefined;
  const licence =
    CLAWHUB_TERMS.licence === "per-artifact"
      ? undefined
      : CLAWHUB_TERMS.licence;
  const item = {
    description: stringField(meta, "description") ?? candidate.description,
    id,
    kind: "skill",
    source: provenance({
      ...(licence === undefined
        ? { license: "MIT-0", licenseId: "MIT-0", shareAlike: false }
        : licenceFields(licence)),
      creditText: `${CLAWHUB_TERMS.creditText ?? "Published on ClawHub"} by @${ref.owner}`,
      digest:
        published.security?.sha256hash === undefined ||
        published.security.sha256hash === null
          ? undefined
          : `sha256:${published.security.sha256hash.toLowerCase()}`,
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
export function clawHubRef(
  item: Item
): { owner: string; slug: string } | undefined {
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
  const detail = await skill(context, ref.owner, ref.slug);
  if (detail === null) {
    return { status: "gone" };
  }
  const version = detail.latestVersion?.version;
  const latest = {
    url: listingUrl(ref.owner, ref.slug),
    ...(version === undefined ? {} : { version }),
  };
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
