import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * `timeout: 0` turns a wait off. A proof that waits for something that never
 * happens then holds the release gate for as long as it hangs, and the run ends
 * in a harness kill with no trace instead of a failure naming the missing
 * observable. Every deadline in evidence is a hang guard far above healthy
 * latency, never `0`.
 */

const evidenceFilePattern =
  /(?:^|\/)(?:[^/]+\.(?:test|spec|manifest|graph)\.ts|[^/]*(?:playwright|vite)[^/]*\.config\.ts)$/;

/** Every deadline a runner or a proof can disable with `0`. */
/** Setters that disable a deadline when called with `0`: `test.setTimeout(0)`, `page.setDefaultTimeout(0)`. */
const timeoutSetters = new Set([
  "setTimeout",
  "setDefaultTimeout",
  "setDefaultNavigationTimeout",
]);

const timeoutKeys = new Set([
  "timeout",
  "testTimeout",
  "hookTimeout",
  "teardownTimeout",
  "navigationTimeout",
  "actionTimeout",
]);

function isZero(node: ESTree.Node): boolean {
  return node.type === "Literal" && node.value === 0;
}

function isTimeoutKey(node: ESTree.Node): boolean {
  if (node.type === "Identifier") return timeoutKeys.has(node.name);
  return (
    node.type === "Literal" &&
    typeof node.value === "string" &&
    timeoutKeys.has(node.value)
  );
}

/** Ban a disabled deadline in evidence and its runner configuration. */
export const noUnboundedWaitRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a zero timeout in evidence and Playwright or Vite configuration; bound every wait with a hang guard.",
    },
    messages: {
      unbounded:
        "A zero timeout disables the deadline, so a hang holds the release until something kills it. Use a hang guard far above healthy latency so a hang fails with a trace.",
    },
  },
  createOnce(context) {
    return {
      Property(node) {
        if (!evidenceFilePattern.test(context.filename)) return;
        if (node.computed || !isTimeoutKey(node.key) || !isZero(node.value))
          return;
        context.report({ node, messageId: "unbounded" });
      },
      CallExpression(node) {
        if (!evidenceFilePattern.test(context.filename)) return;
        const callee = node.callee;
        // Only a method call: a bare `setTimeout(fn, 0)` schedules work, it does not set a deadline.
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier"
        )
          return;
        if (
          !timeoutSetters.has(callee.property.name) ||
          node.arguments.length !== 1
        )
          return;
        const [deadline] = node.arguments;
        if (deadline !== undefined && isZero(deadline))
          context.report({ node, messageId: "unbounded" });
      },
    };
  },
});
