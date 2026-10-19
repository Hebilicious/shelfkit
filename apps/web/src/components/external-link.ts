/**
 * A link out of ShelfKit to an address that came from data (a scanner's report, a source's record). Only web and mail
 * URLs pass `safeHref`; anything else renders as plain text, so a `javascript:` URL in a shelf is never clickable.
 */
import { defineComponent, h } from "vue";

import { safeHref } from "../lib/markdown.ts";

export default defineComponent({
  name: "ExternalLink",
  props: {
    address: { required: true, type: String },
  },
  setup(props, { slots }) {
    return () => {
      const href = safeHref(props.address);
      const content = slots.default?.() ?? props.address;
      return href === null
        ? h("span", content)
        : h(
            "a",
            { href, rel: "noopener noreferrer nofollow", target: "_blank" },
            content
          );
    };
  },
});
