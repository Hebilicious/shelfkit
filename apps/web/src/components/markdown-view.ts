/**
 * Draws the allowlisted tree `lib/markdown.ts` builds. No `v-html` and no `innerHTML`: every element is created
 * from the tree, so markdown cannot inject markup.
 */
import { defineComponent, h } from "vue";
import type { VNode } from "vue";

import { isText, renderMarkdown } from "../lib/markdown.ts";
import type { MarkdownNode } from "../lib/markdown.ts";

function draw(nodes: readonly MarkdownNode[]): (VNode | string)[] {
  return nodes.map((node) =>
    isText(node) ? node : h(node.tag, { ...node.attrs }, draw(node.children))
  );
}

export default defineComponent({
  name: "MarkdownView",
  props: {
    source: { required: true, type: String },
  },
  setup(props) {
    return () =>
      h("div", { class: "markdown" }, draw(renderMarkdown(props.source)));
  },
});
