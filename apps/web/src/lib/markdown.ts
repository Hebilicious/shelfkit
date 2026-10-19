/**
 * Markdown for item content, rendered safe by construction.
 *
 * markdown-it parses; nothing it produces is ever used as HTML. Its tokens become a small tree of allowlisted
 * elements that a Vue render function draws, so:
 *
 * - raw HTML in the source (blocks and inline tags) is stripped, never escaped into view and never rendered;
 * - only the tags below exist, with only `href` (http, https, mailto, or a fragment), `start` and `colspan`-free
 *   table alignment carried over;
 * - an image is never loaded: it becomes a marker naming its alt text and its address, so a shelf cannot make the
 *   browser fetch a tracking pixel.
 */
import MarkdownIt from "markdown-it";
import type { Token } from "markdown-it";

/** An element of rendered markdown, or its text. */
export type MarkdownNode = MarkdownElement | string;

/** The only attributes an element may carry. */
type AttributeName =
  | "class"
  | "data-align"
  | "data-language"
  | "href"
  | "rel"
  | "start"
  | "target"
  | "title";

export type MarkdownAttributes = Partial<Record<AttributeName, string>>;

export interface MarkdownElement {
  readonly tag: AllowedTag;
  readonly attrs: Readonly<MarkdownAttributes>;
  readonly children: MarkdownNode[];
}

/** Whether a node is text rather than an element. */
export function isText(node: MarkdownNode): node is string {
  return typeof node === "string";
}

const ALLOWED_TAGS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
] as const;

export type AllowedTag = (typeof ALLOWED_TAGS)[number];

function isAllowedTag(tag: string): tag is AllowedTag {
  return ALLOWED_TAGS.some((allowed) => allowed === tag);
}

/** Links that may be followed: the web, mail, and anchors within the page. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed.startsWith("#")) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const parser = new MarkdownIt({
  // Raw HTML is parsed so it can be dropped as a token, rather than escaped into the text.
  html: true,
  linkify: true,
  typographer: false,
});

function element(
  tag: AllowedTag,
  children: MarkdownNode[] = [],
  attrs: MarkdownAttributes = {}
): MarkdownElement {
  return { attrs, children, tag };
}

/** An attribute as text; markdown-it types numeric attributes (a list's `start`) as numbers. */
function attr(token: Token, name: string): string | null {
  const value = token.attrGet(name);
  return value === null ? null : String(value);
}

function attrsOf(token: Token): MarkdownAttributes {
  const attrs: MarkdownAttributes = {};
  if (token.tag === "a") {
    const href = safeHref(attr(token, "href") ?? "");
    if (href !== null) {
      attrs.href = href;
      if (!href.startsWith("#")) {
        attrs.rel = "noopener noreferrer nofollow";
        attrs.target = "_blank";
      }
    }
  }
  if (token.tag === "ol") {
    const start = attr(token, "start");
    if (start !== null && /^\d+$/u.test(start)) {
      attrs.start = start;
    }
  }
  if (token.tag === "td" || token.tag === "th") {
    const style = attr(token, "style") ?? "";
    const align = /text-align:(?<align>left|right|center)/u.exec(style)?.groups
      ?.align;
    if (align !== undefined) {
      attrs["data-align"] = align;
    }
  }
  return attrs;
}

/** An image, blocked: its alt text and where it would have come from. */
function blockedImage(token: Token): MarkdownElement {
  const alt = token.content.trim() === "" ? "image" : token.content.trim();
  const source = attr(token, "src") ?? "";
  return element(
    "span",
    [`[${alt}: image not loaded${source === "" ? "" : ` (${source})`}]`],
    {
      class: "md-blocked-image",
      title: "Images are not loaded from item content",
    }
  );
}

/** What a token that opens or closes nothing becomes. */
function leaf(token: Token): MarkdownNode[] {
  switch (token.type) {
    case "text": {
      return [token.content];
    }
    case "inline": {
      return build(token.children ?? []);
    }
    case "code_inline": {
      return [element("code", [token.content])];
    }
    case "code_block":
    case "fence": {
      const [language = ""] = token.info.trim().split(/\s+/u);
      return [
        element(
          "pre",
          [element("code", [token.content])],
          language === "" ? {} : { "data-language": language }
        ),
      ];
    }
    case "softbreak": {
      return ["\n"];
    }
    case "hardbreak": {
      return [element("br")];
    }
    case "hr": {
      return [element("hr")];
    }
    case "image": {
      return [blockedImage(token)];
    }
    default: {
      return token.content === "" ? [] : [token.content];
    }
  }
}

/** Convert a flat run of tokens, opening and closing elements as it goes. Raw HTML tokens are dropped. */
function build(tokens: readonly Token[]): MarkdownNode[] {
  const root: MarkdownNode[] = [];
  const open: MarkdownNode[][] = [root];
  for (const token of tokens) {
    const children = open.at(-1) ?? root;
    if (token.type === "html_block" || token.type === "html_inline") {
      continue;
    }
    if (token.nesting === 1) {
      // A tag outside the allowlist (none that markdown-it emits today) keeps its content in a span.
      const node = element(
        isAllowedTag(token.tag) ? token.tag : "span",
        [],
        attrsOf(token)
      );
      children.push(node);
      open.push(node.children);
    } else if (token.nesting === -1) {
      if (open.length > 1) {
        open.pop();
      }
    } else {
      children.push(...leaf(token));
    }
  }
  return root;
}

/** Render markdown to a tree of allowlisted elements. */
export function renderMarkdown(source: string): MarkdownNode[] {
  return build(parser.parse(source, {}));
}

/** The text of a rendered tree, for tests and accessible summaries. */
export function textOf(nodes: readonly MarkdownNode[]): string {
  return nodes
    .map((node) => (isText(node) ? node : textOf(node.children)))
    .join("");
}
