/**
 * `/graphql`: GraphQL Yoga over the Pothos schema, for queries, mutations, and subscriptions over server-sent events.
 * The request is authenticated before Yoga sees it: a credential that is not a valid key is `401`, so a revoked key
 * fails here at once, as on the registry and `/mcp`.
 */
import { createYoga } from "graphql-yoga";

import { authenticate } from "../auth/index.ts";
import { unauthorized } from "../http.ts";
import { once } from "../runtime/once.ts";
import { createContext } from "./context.ts";
import type { GraphQLContext } from "./context.ts";
import { buildSchema } from "./schema.ts";

const yoga = once(() =>
  createYoga<GraphQLContext>({
    graphiql: false,
    graphqlEndpoint: "/graphql",
    landingPage: false,
    schema: buildSchema(),
  })
);

export async function graphqlRoute(
  request: Request,
  env: Env,
  execution: ExecutionContext
): Promise<Response> {
  const session = await authenticate(request, env);
  if (session.kind === "invalid") {
    return unauthorized(
      "the key is not valid: it is malformed, unknown, or revoked"
    );
  }
  const context = createContext(env, request, session, execution);
  const response = await yoga().fetch(request, context);
  if (context.cookies.length === 0) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const cookie of context.cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(response.body, { headers, status: response.status });
}
