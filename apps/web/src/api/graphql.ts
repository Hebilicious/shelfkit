/**
 * The one way the SPA talks to the service: GraphQL at `/graphql`, the same API the CLI uses (`docs/PRD.md` section 9).
 *
 * Operations are typed against the committed SDL (`apps/worker/schema.graphql`) by gql.tada: `moon run
 * web:graphql-types` writes the introspection types this module reads, and `moon run web:graphql-check` fails the gate
 * when an operation no longer validates against the schema.
 *
 * Requests are same-origin `application/json` POSTs. The browser holds its session in the `HttpOnly` cookie that
 * signing in with GitHub sets, and sends this origin's `Origin` header itself, which the Worker requires of a
 * cookie-authenticated POST.
 */
import { print } from "@0no-co/graphql.web";
import { initGraphQLTada } from "gql.tada";
import type { TadaDocumentNode } from "gql.tada";
import * as v from "valibot";

import type { introspection } from "./graphql-env.d.ts";

export const graphql = initGraphQLTada<{
  introspection: introspection;
  scalars: {
    DateTime: string;
    // A JSON value is checked with a Valibot schema where it is read (`json.ts`), never trusted as a shape here.
    JSON: unknown;
  };
}>();

export type { ResultOf, VariablesOf } from "gql.tada";

/** A GraphQL error as the response carries it: its message and, from Yoga, a code such as `FORBIDDEN`. */
export interface GraphQLProblem {
  readonly message: string;
  readonly code: string | null;
}

/** A request the service answered with errors, or did not answer with GraphQL at all. */
export class GraphQLRequestError extends Error {
  readonly problems: readonly GraphQLProblem[];
  readonly status: number;

  constructor(
    message: string,
    status: number,
    problems: readonly GraphQLProblem[]
  ) {
    super(message);
    this.name = "GraphQLRequestError";
    this.status = status;
    this.problems = problems;
  }

  /** Whether the service refused for want of access: sign-in needed, or the key may not do this. */
  get unauthorized(): boolean {
    return (
      this.status === 401 ||
      this.problems.some(
        (problem) =>
          problem.code === "FORBIDDEN" || problem.code === "UNAUTHENTICATED"
      )
    );
  }
}

const ResponseSchema = v.object({
  data: v.optional(v.nullable(v.unknown())),
  errors: v.optional(
    v.array(
      v.object({
        extensions: v.optional(v.object({ code: v.optional(v.string()) })),
        message: v.string(),
      })
    )
  ),
});

const ProblemDetailsSchema = v.object({
  detail: v.optional(v.string()),
  title: v.optional(v.string()),
});

/** The text of a failed HTTP answer: its problem details when it has them. */
async function failureText(response: Response): Promise<string> {
  try {
    const parsed = v.safeParse(ProblemDetailsSchema, await response.json());
    if (parsed.success) {
      return parsed.output.detail ?? parsed.output.title ?? response.statusText;
    }
  } catch {
    // Not JSON: the status line says enough.
  }
  return `${response.status} ${response.statusText}`;
}

/** What to do when the service refuses for want of access; `session.ts` reloads who the browser is. */
let onRefusal: (() => void) | null = null;

/**
 * Be told when a request is refused for want of access. A key revoked elsewhere leaves the browser's cookie cleared
 * and its requests anonymous, so the first refusal is when the page learns it is signed out.
 */
export function whenRefused(handler: () => void): void {
  onRefusal = handler;
}

function refused(error: GraphQLRequestError): GraphQLRequestError {
  if (error.unauthorized) {
    onRefusal?.();
  }
  return error;
}

/** Run one operation and return its data, or throw a `GraphQLRequestError` with every problem. */
export async function execute<TResult, TVariables>(
  document: TadaDocumentNode<TResult, TVariables>,
  variables: TVariables
): Promise<TResult> {
  const response = await fetch("/graphql", {
    body: JSON.stringify({ query: print(document), variables }),
    credentials: "same-origin",
    headers: {
      accept: "application/graphql-response+json, application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const media = response.headers.get("content-type") ?? "";
  if (!media.includes("json")) {
    throw refused(
      new GraphQLRequestError(await failureText(response), response.status, [])
    );
  }
  const parsed = v.safeParse(ResponseSchema, await response.json());
  if (!parsed.success) {
    throw refused(
      new GraphQLRequestError(
        `${response.status}: an answer that is not GraphQL`,
        response.status,
        []
      )
    );
  }
  const { data, errors = [] } = parsed.output;
  if (errors.length > 0 || data === undefined || data === null) {
    const problems = errors.map((error) => ({
      code: error.extensions?.code ?? null,
      message: error.message,
    }));
    const message =
      problems.map((problem) => problem.message).join("; ") ||
      (response.ok
        ? "the service answered with no data"
        : `${response.status} ${response.statusText}`);
    throw refused(new GraphQLRequestError(message, response.status, problems));
  }
  // SAFETY: the document was validated against the SDL the server serves (`web:graphql-check`), and Yoga answers with
  // exactly the selection requested, so `data` has the document's result shape.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the SAFETY note above is why this `data` is a `TResult`.
  return data as TResult;
}

/** The query string and variables for a `GET` (used by the SSE subscription). */
export function getUrl<TResult, TVariables>(
  document: TadaDocumentNode<TResult, TVariables>,
  variables: TVariables
): string {
  const params = new URLSearchParams({
    query: print(document),
    variables: JSON.stringify(variables),
  });
  return `/graphql?${params.toString()}`;
}

/**
 * A message fit for a person, from anything a request threw.
 * BOUNDARY: a `catch` hands over whatever was thrown; this reads an `Error`'s message, or the value as text.
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
