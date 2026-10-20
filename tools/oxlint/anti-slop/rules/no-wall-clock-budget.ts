import { defineRule } from "@oxlint/plugins";
import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

/**
 * A proof whose outcome depends on how fast the machine is cannot fail for a
 * reason a candidate controls. It fails on a loaded release gate, passes on an
 * idle laptop, and the cheapest way for anyone to get a green suite is to edit
 * the threshold, which buys nothing and hides the next real regression.
 *
 * This rule rejects a wall-clock budget asserted as an expectation. A wait with
 * a deadline is fine: a test may poll for an observable, bound it by a hang
 * guard far above healthy latency, and report the measured duration as
 * diagnostic. What it may not do is require the machine to be quick.
 */

const minimumBudgetMilliseconds = 1;

/**
 * The rule governs evidence. Production code may classify a measured duration
 * into a telemetry bucket; a test may not require a duration to be short.
 */
const evidenceFilePattern =
  /(?:^|\/)(?:[^/]+\.(?:test|spec|manifest|graph)\.ts)$/;

/** Matchers that state "the actual value is below this budget". */
const upperBoundMatchers = new Set(["toBeLessThan", "toBeLessThanOrEqual"]);

function isEvidenceFile(filename: string): boolean {
  return evidenceFilePattern.test(filename);
}

function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/**
 * The number a budget operand stands for: a literal, a negated literal, or a
 * `const` binding initialised with one directly or through other `const`
 * aliases, so moving the budget into a named constant does not take it out of
 * the rule's reach.
 */
function numericValue(
  sourceCode: SourceCode,
  node: ESTree.Node,
  followed = new Set<Variable>()
): number | null {
  if (node.type === "Literal" && typeof node.value === "number")
    return node.value;
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument.type === "Literal"
  ) {
    const value = node.argument.value;
    return typeof value === "number" ? -value : null;
  }
  if (node.type === "Identifier") {
    const variable = resolveVariable(sourceCode, node);
    // A chain of aliases can close on itself, `const a = b, b = a`, so each binding
    // is followed once.
    if (variable === null || followed.has(variable)) return null;
    followed.add(variable);
    const definition = variable.defs[0];
    if (
      definition?.type !== "Variable" ||
      definition.parent?.type !== "VariableDeclaration"
    )
      return null;
    if (
      definition.parent.kind !== "const" ||
      definition.node.type !== "VariableDeclarator"
    )
      return null;
    const init = definition.node.init;
    return init === null ? null : numericValue(sourceCode, init, followed);
  }
  return null;
}

/**
 * Only a name that states a whole duration, not any name containing a duration
 * word: an identifier is a measurement when it ends in a unit or names a
 * measured quantity, while `frameCount` and `attempt` must not be mistaken for
 * one or the rule would flag its own bounded loops.
 */
function isDurationName(name: string): boolean {
  const lower = name.toLowerCase();
  const measured =
    /(?:milliseconds|millisecond|millis|ms|nanoseconds|seconds|elapsed|latency)$/.test(
      lower
    );
  const quantity =
    /^(?:median|mean|average|p95|p99|worst|max|min|slow|total)/.test(lower);
  return (
    measured ||
    (quantity && /duration|latency|frame|interval|time|elapsed/.test(lower))
  );
}

/**
 * `elapsed` from `performance.now()` and its kin is a duration, while a
 * geometry measurement is not. Only a duration may be compared against a
 * millisecond budget, and a geometry comparison is not this rule's business.
 */
function isDurationExpression(node: ESTree.Node): boolean {
  if (node.type === "CallExpression") {
    const callee = node.callee;
    if (
      callee.type !== "MemberExpression" ||
      callee.computed ||
      callee.property.type !== "Identifier"
    )
      return false;
    const method = callee.property.name;
    return method === "now" || method === "getTime" || method === "valueOf";
  }
  if (node.type === "BinaryExpression" && node.operator === "-") {
    return isDurationExpression(node.left) || isDurationExpression(node.right);
  }
  if (node.type === "Identifier") return isDurationName(node.name);
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier"
  ) {
    return isDurationName(node.property.name);
  }
  return false;
}

/**
 * A comparison that decides whether a loop keeps waiting is a hang guard, not an
 * expectation: `while (performance.now() - start < 5_000)` bounds a poll and the
 * observable inside the loop carries the proof.
 */
function isLoopCondition(node: ESTree.Node): boolean {
  let current = node;
  let parent = node.parent;
  while (parent !== null && parent !== undefined && parent.type !== "Program") {
    if (
      (parent.type === "WhileStatement" ||
        parent.type === "DoWhileStatement" ||
        parent.type === "ForStatement") &&
      parent.test === current
    ) {
      return true;
    }
    if (
      parent.type !== "LogicalExpression" &&
      parent.type !== "UnaryExpression"
    )
      return false;
    current = parent;
    parent = parent.parent;
  }
  return false;
}

/** `expect(duration)` for a `toBeLessThan*` call, or `null` when the call is anything else. */
function expectedUpperBoundSubject(
  node: ESTree.CallExpression
): ESTree.Node | null {
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.property.type !== "Identifier"
  )
    return null;
  if (!upperBoundMatchers.has(callee.property.name)) return null;
  const expectation = callee.object;
  if (
    expectation.type !== "CallExpression" ||
    expectation.callee.type !== "Identifier"
  )
    return null;
  if (expectation.callee.name !== "expect") return null;
  return expectation.arguments[0] ?? null;
}

/** Ban a wall-clock budget asserted as an expectation. */
export const noWallClockBudgetRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow wall-clock budgets and elapsed-time comparisons in evidence; wait for the observable and bound it with a hang guard instead.",
    },
    messages: {
      budget:
        "A wall-clock budget cannot fail for a candidate's reason. Wait for the observable condition, bound it with a hang guard far above healthy latency, and keep the measured milliseconds as diagnostic rather than as an expectation.",
    },
  },
  createOnce(context) {
    const isBudget = (node: ESTree.Node): boolean => {
      const budget = numericValue(context.sourceCode, node);
      return budget !== null && budget >= minimumBudgetMilliseconds;
    };
    return {
      BinaryExpression(node) {
        if (!isEvidenceFile(context.filename)) return;
        // `elapsed < 500` and its mirror `500 > elapsed` state the same budget.
        const below =
          node.operator === "<" || node.operator === "<="
            ? { duration: node.left, budget: node.right }
            : node.operator === ">" || node.operator === ">="
              ? { duration: node.right, budget: node.left }
              : null;
        if (
          below === null ||
          !isDurationExpression(below.duration) ||
          !isBudget(below.budget)
        )
          return;
        if (isLoopCondition(node)) return;
        context.report({ node, messageId: "budget" });
      },
      CallExpression(node) {
        if (!isEvidenceFile(context.filename)) return;
        const subject = expectedUpperBoundSubject(node);
        const budget = node.arguments[0];
        if (
          subject === null ||
          budget === undefined ||
          !isDurationExpression(subject) ||
          !isBudget(budget)
        )
          return;
        context.report({ node, messageId: "budget" });
      },
    };
  },
});
