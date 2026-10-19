import type { ESTree, SourceCode } from "@oxlint/plugins";

/** Return whether a `BOUNDARY:` comment precedes the node or one of its ancestors. */
export function hasBoundaryComment(
  sourceCode: SourceCode,
  node: ESTree.Node
): boolean {
  let current: ESTree.Node = node;
  while (true) {
    if (
      sourceCode
        .getCommentsBefore(current)
        .some((comment) => /\bBOUNDARY\s*:/u.test(comment.value))
    )
      return true;
    if (current.parent.type === "Program") return false;
    current = current.parent;
  }
}
