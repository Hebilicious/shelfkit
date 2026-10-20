import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { hasBoundaryComment } from "../shared/boundary-comment.ts";
import { isGlobalReflectMethodCall } from "../shared/reflect-method.ts";

/** Ban Reflect.get, which bypasses ordinary property access and useful type evidence. */
export const noReflectGetRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Reflect.get; use typed property access or parse dynamic input into a domain type.",
    },
    messages: {
      reflectGet:
        "Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowWithBoundaryComment: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowWithBoundaryComment: false }],
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type === "Super" ||
          node.callee.type === "V8IntrinsicExpression"
        )
          return;
        if (isGlobalReflectMethodCall(context.sourceCode, node.callee, "get")) {
          const option = context.options?.[0];
          const allowWithBoundaryComment =
            typeof option === "object" &&
            option !== null &&
            !Array.isArray(option) &&
            option.allowWithBoundaryComment === true;
          if (
            allowWithBoundaryComment &&
            hasBoundaryComment(context.sourceCode, node)
          )
            return;
          context.report({ node, messageId: "reflectGet" });
        }
      },
    };
  },
});
