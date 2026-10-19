import { describe, expect, it } from "vitest";

import {
  isText,
  renderMarkdown,
  safeHref,
  textOf,
} from "../../src/lib/markdown.ts";
import type { MarkdownNode } from "../../src/lib/markdown.ts";

function tags(nodes: readonly MarkdownNode[]): string[] {
  return nodes.flatMap((node) =>
    isText(node) ? [] : [node.tag, ...tags(node.children)]
  );
}

function links(
  nodes: readonly MarkdownNode[]
): Readonly<Record<string, string>>[] {
  return nodes.flatMap((node) =>
    isText(node)
      ? []
      : [...(node.tag === "a" ? [node.attrs] : []), ...links(node.children)]
  );
}

describe("rendering item markdown", () => {
  it("renders the usual structure", () => {
    const nodes = renderMarkdown(
      "# Title\n\nSome *em* and `code`.\n\n- one\n- two\n\n```ts\nlet x = 1;\n```\n"
    );
    expect(tags(nodes)).toStrictEqual([
      "h1",
      "p",
      "em",
      "code",
      "ul",
      "li",
      "p",
      "li",
      "p",
      "pre",
      "code",
    ]);
    expect(textOf(nodes)).toContain("let x = 1;");
  });

  it("strips raw HTML, block and inline, rather than showing or rendering it", () => {
    const nodes = renderMarkdown(
      '<div onclick="steal()">block</div>\n\nText <script>alert(1)</script> and <b>bold</b> <img src=x onerror=alert(1)>\n'
    );
    const text = textOf(nodes);
    expect(text).not.toContain("<");
    expect(text).not.toContain("script");
    expect(text).not.toContain("onclick");
    expect(tags(nodes)).not.toContain("div");
    expect(text).toContain("bold");
  });

  it("never loads an image: a remote image becomes a marker naming it", () => {
    const nodes = renderMarkdown("![pixel](https://tracker.example/p.gif)\n");
    expect(JSON.stringify(nodes)).not.toContain('"src"');
    expect(textOf(nodes)).toBe(
      "[pixel: image not loaded (https://tracker.example/p.gif)]"
    );
  });

  it("keeps only safe links, opened without a referrer", () => {
    const nodes = renderMarkdown(
      "[ok](https://example.com) [bad](javascript:alert(1)) [data](data:text/html,x)\n"
    );
    const anchors = links(nodes);
    expect(anchors).toStrictEqual([
      {
        href: "https://example.com/",
        rel: "noopener noreferrer nofollow",
        target: "_blank",
      },
    ]);
    // The refused links stay as their text, which is inert.
    expect(textOf(nodes)).toContain("[bad](javascript:alert(1))");
  });

  it("accepts only web, mail and fragment links", () => {
    expect(safeHref("#section")).toBe("#section");
    expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeHref("vbscript:x")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
  });
});
