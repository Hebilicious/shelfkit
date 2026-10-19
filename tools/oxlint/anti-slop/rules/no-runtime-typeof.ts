import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import { hasBoundaryComment } from "../shared/boundary-comment.ts";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  );
}

function isInsideTypeGuard(node: ESTree.Node): boolean {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (
      isRuntimeFunction(current) &&
      current.returnType?.typeAnnotation.type === "TSTypePredicate"
    )
      return true;
    current = current.parent;
  }
  return false;
}

function enclosingRuntimeFunction(node: ESTree.Node): RuntimeFunction | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (isRuntimeFunction(current)) return current;
    current = current.parent;
  }
  return null;
}

function hasOwnerBoundaryComment(
  sourceCode: SourceCode,
  node: ESTree.Node
): boolean {
  const owner = enclosingRuntimeFunction(node);
  return owner !== null && hasBoundaryComment(sourceCode, owner);
}

/** Return whether typeof safely probes for the existence of a possibly absent binding. */
function isExistenceProbe(node: ESTree.UnaryExpression): boolean {
  const parent = node.parent;
  if (parent.type !== "BinaryExpression") return false;
  if (!["===", "!==", "==", "!="].includes(parent.operator)) return false;
  const other = parent.left === node ? parent.right : parent.left;
  return other.type === "Literal" && other.value === "undefined";
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
    },
    messages: {
      runtimeTypeof:
        "A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowWithBoundaryComment: { type: "boolean" },
          allowInTypeGuards: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      { allowInTypeGuards: false, allowWithBoundaryComment: false },
    ],
  },
  createOnce(context) {
    return {
      UnaryExpression(node) {
        const option = context.options?.[0];
        const allowInTypeGuards =
          typeof option === "object" &&
          option !== null &&
          !Array.isArray(option) &&
          option.allowInTypeGuards === true;
        const allowWithBoundaryComment =
          typeof option === "object" &&
          option !== null &&
          !Array.isArray(option) &&
          option.allowWithBoundaryComment === true;
        if (
          node.operator === "typeof" &&
          !isExistenceProbe(node) &&
          (!allowInTypeGuards || !isInsideTypeGuard(node)) &&
          (!allowWithBoundaryComment ||
            !hasOwnerBoundaryComment(context.sourceCode, node))
        ) {
          context.report({ node, messageId: "runtimeTypeof" });
        }
      },
    };
  },
});
