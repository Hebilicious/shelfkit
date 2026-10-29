/**
 * Docs a repository's AGENTS.md links to (`docs/PRD.md` section 5.2, `doc`): the reference documents its instructions
 * send an agent to. This module only reads text and paths; the adapter fetches the files.
 *
 * A link counts when it is a relative markdown link, inline `[x](path)` or a reference definition `[x]: path`, written
 * plain or as `./path`, with or without a `#fragment`, whose target is a markdown file of the repository that is not
 * a primitive of its own (`.prompt.md`, `.instructions.md`, `.agent.md`, `SKILL.md`). A URL, an anchor, an absolute
 * path, and a path that climbs out of the imported tree are ignored. These are the links the compiler points at a
 * doc's installed copy (`crates/compiler/src/docs.rs`), so what is found here is what compiles.
 */
import { DocPathSchema } from "@shelfkit/schema";
import * as v from "valibot";

import { basename, parent } from "./layouts.ts";

/** At most this many docs are followed from one AGENTS.md, so one discovery stays within a Worker's subrequests. */
export const MAX_DOCS = 40;

/** File names that are a primitive of their own, never a doc. */
const PRIMITIVES = [".prompt.md", ".instructions.md", ".agent.md"];

/** Whether a file is a markdown file that is not a primitive of its own. */
export function isDocFile(path: string): boolean {
  const name = basename(path);
  return (
    name.endsWith(".md") &&
    name !== "SKILL.md" &&
    !PRIMITIVES.some((suffix) => name.endsWith(suffix))
  );
}

/** Whether a path can be a doc's `path`: what the shelf format accepts. */
export function isDocPath(path: string): boolean {
  return v.is(DocPathSchema, path);
}

/**
 * The `path` a doc at `path` in its repository gets when the tree at `tree` is imported: relative to that tree, since
 * that is how the tree's AGENTS.md links to it, and the compiler points those links at the doc's installed copy. A doc
 * outside the tree keeps its repository path.
 */
export function docPathIn(tree: string | undefined, path: string): string {
  const base = (tree ?? "").replaceAll(/^\/+|\/+$/gu, "");
  return base !== "" && path.startsWith(`${base}/`)
    ? path.slice(base.length + 1)
    : path;
}

/** The text with fenced code blocks blanked, so a link shown as an example is not followed. */
function outsideCode(text: string): string[] {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    const opening = /^\s{0,3}(?<marks>`{3,}|~{3,})/u.exec(line)?.groups?.marks;
    if (fence === undefined && opening !== undefined) {
      fence = opening.charAt(0);
    } else if (
      fence !== undefined &&
      line.trimStart().startsWith(fence.repeat(3))
    ) {
      fence = undefined;
    } else if (fence === undefined) {
      lines.push(line.replaceAll(/`[^`]*`/gu, ""));
    }
  }
  return lines;
}

/** A link destination as written: `<path>` unwrapped, and a title after it dropped. */
function destination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end === -1 ? "" : trimmed.slice(1, end);
  }
  return trimmed.split(/\s/u)[0] ?? "";
}

/** Every link destination in a markdown text, in order, inline links and reference definitions alike. */
export function markdownLinks(text: string): string[] {
  const links: string[] = [];
  for (const line of outsideCode(text)) {
    const reference = /^\s{0,3}\[[^\]]+\]:\s*(?<target>.+)$/u.exec(line)?.groups
      ?.target;
    if (reference !== undefined) {
      links.push(destination(reference));
      continue;
    }
    for (const match of line.matchAll(/\]\((?<target>[^)]*)\)/gu)) {
      links.push(destination(match.groups?.target ?? ""));
    }
  }
  return links.filter((link) => link !== "");
}

/**
 * The repository path a link in the file at `from` points to, or `undefined` when it points nowhere a doc can be: a
 * URL (any scheme), an anchor, an absolute path, a query, or a path that climbs above the repository's root.
 */
export function resolveLink(from: string, link: string): string | undefined {
  const [target = ""] = link.split("#");
  if (
    target === "" ||
    target.startsWith("/") ||
    target.includes("?") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target)
  ) {
    return undefined;
  }
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return undefined;
  }
  const segments = parent(from) === "" ? [] : parent(from).split("/");
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return undefined;
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.length === 0 ? undefined : segments.join("/");
}

/** A markdown file's first top-level heading after its frontmatter, or `undefined` when it has none. */
export function firstHeading(text: string): string | undefined {
  const normalized = text.replaceAll("\r\n", "\n").replace(/^﻿/u, "");
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---", 4);
    body = end === -1 ? normalized : normalized.slice(end + 4);
  }
  for (const line of outsideCode(body)) {
    const heading = /^# (?<title>.+)$/u.exec(line)?.groups?.title?.trim();
    if (heading !== undefined && heading !== "") {
      return heading.replace(/\s+#+$/u, "");
    }
  }
  return undefined;
}

/** One doc found by following links, and the docs it links to in turn. */
export interface FoundDoc {
  /** Its repository path. */
  readonly path: string;
  /** Its first heading, when it has one. */
  readonly heading: string | undefined;
  /** The repository paths of the docs it links to. */
  readonly links: readonly string[];
}

/** What following the links of one AGENTS.md found. */
export interface FollowedDocs {
  /** The docs AGENTS.md links to, directly or through another doc, in the order they were reached. */
  readonly docs: readonly FoundDoc[];
  /** The docs AGENTS.md itself links to. */
  readonly links: readonly string[];
  /** Its first heading, when it has one. */
  readonly heading: string | undefined;
  /** Whether more docs were linked than `MAX_DOCS`. */
  readonly truncated: boolean;
}

/**
 * Follow the links of the AGENTS.md at `start`, breadth first, through every doc they reach. `isDoc` says whether a
 * repository path is a doc there (a regular markdown file inside the imported tree); `read` answers a file's text.
 */
export async function followDocs(
  start: string,
  isDoc: (path: string) => boolean,
  read: (path: string) => Promise<string | undefined>
): Promise<FollowedDocs> {
  const linksOf = (from: string, text: string): string[] => [
    ...new Set(
      markdownLinks(text).flatMap((link) => {
        const path = resolveLink(from, link);
        return path !== undefined &&
          path !== start &&
          isDocFile(path) &&
          isDocPath(path) &&
          isDoc(path)
          ? [path]
          : [];
      })
    ),
  ];
  const text = (await read(start)) ?? "";
  const top = linksOf(start, text);
  const docs: FoundDoc[] = [];
  const seen = new Set(top);
  let frontier = top;
  let truncated = false;
  while (frontier.length > 0) {
    const room = MAX_DOCS - docs.length;
    if (frontier.length > room) {
      truncated = true;
    }
    const level = frontier.slice(0, Math.max(room, 0));
    // oxlint-disable-next-line eslint/no-await-in-loop -- each level's links are only known once the level is read.
    const texts = await Promise.all(
      level.map(async (path) => await read(path))
    );
    const next: string[] = [];
    for (const [index, path] of level.entries()) {
      const body = texts[index] ?? "";
      const links = linksOf(path, body);
      docs.push({ heading: firstHeading(body), links, path });
      for (const link of links) {
        if (!seen.has(link)) {
          seen.add(link);
          next.push(link);
        }
      }
    }
    frontier = docs.length >= MAX_DOCS ? [] : next;
    if (docs.length >= MAX_DOCS && next.length > 0) {
      truncated = true;
    }
  }
  return { docs, heading: firstHeading(text), links: top, truncated };
}
