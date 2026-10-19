import { defineRule } from "@oxlint/plugins";

/**
 * A module-level `let` or `var` is one value shared by every request a Worker isolate serves and by every session a
 * headless owner hosts, so state written for one caller leaks into the next. State belongs in a `Ref` inside a Layer,
 * an actor's context, or storage.
 */
export const noModuleLevelMutableStateRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow module-level let and var bindings.",
    },
    messages: {
      moduleState:
        "Module-level `{{kind}}` is shared by every request and session this module serves. Keep the state in a Ref inside a Layer, an actor's context, or storage.",
    },
  },
  createOnce(context) {
    return {
      VariableDeclaration(node) {
        if (node.kind !== "let" && node.kind !== "var") return;
        const parent = node.parent;
        const moduleLevel =
          parent.type === "Program" ||
          ((parent.type === "ExportNamedDeclaration" ||
            parent.type === "ExportDefaultDeclaration") &&
            parent.parent.type === "Program");
        if (moduleLevel)
          context.report({
            node,
            messageId: "moduleState",
            data: { kind: node.kind },
          });
      },
    };
  },
});
