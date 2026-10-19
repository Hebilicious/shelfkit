import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { hasBoundaryComment } from "../shared/boundary-comment.ts";
import {
  containsUnknownType,
  functionParameterBindingName,
  functionParameterTypeAnnotation,
} from "../shared/function-parameters.ts";
type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function hasTypePredicate(owner: ParameterOwner): boolean {
  return owner.returnType?.typeAnnotation.type === "TSTypePredicate";
}

function isTypePredicateSubject(
  owner: ParameterOwner,
  parameterName: string
): boolean {
  const predicate = owner.returnType?.typeAnnotation;
  return (
    predicate?.type === "TSTypePredicate" &&
    predicate.parameterName.type === "Identifier" &&
    predicate.parameterName.name === parameterName
  );
}

/** Disallow unknown inputs except explicitly named error-cause enrichment. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause` and type-predicate subjects; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
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
    const checkParameters = (node: ParameterOwner) => {
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
      if (allowInTypeGuards && hasTypePredicate(node)) return;
      if (
        allowWithBoundaryComment &&
        hasBoundaryComment(context.sourceCode, node)
      )
        return;
      for (const parameter of node.params) {
        const annotation = functionParameterTypeAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!containsUnknownType(annotation.typeAnnotation)) continue;
        const name = functionParameterBindingName(
          parameter,
          context.sourceCode
        );
        if (name === "cause" || isTypePredicateSubject(node, name)) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
