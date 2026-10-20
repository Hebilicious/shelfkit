/**
 * `/graphql`: GraphQL Yoga over the Pothos schema, for queries, mutations, and subscriptions over server-sent events.
 *
 * Before Yoga sees a request:
 * - It is authenticated. A header credential that is not a valid key is `401`, so a revoked key fails here at once,
 *   as on the registry and `/mcp`. A cookie holding a key that is no longer valid is cleared and the request is
 *   anonymous, so the browser can sign in again.
 * - It is checked against cross-site use. The SPA is same-origin, so there is no CORS. A `POST` must be
 *   `application/json` (no form or multipart body, which a page on another site could send), a request from another
 *   origin must carry its own `Authorization` header, and a `POST` the cookie authenticates must come from this
 *   origin. A `GET` is a query or a subscription; Yoga refuses a mutation over `GET`.
 */
import { createYoga } from "graphql-yoga";

import { authenticateRequest, signOutCookie } from "../auth/index.ts";
import type { CredentialSource } from "../auth/index.ts";
import { problem, unauthorized } from "../http.ts";
import { once } from "../runtime/once.ts";
import { createContext } from "./context.ts";
import type { GraphQLContext } from "./context.ts";
import { buildSchema } from "./schema.ts";

const yoga = once(() =>
  createYoga<GraphQLContext>({
    cors: false,
    graphiql: false,
    graphqlEndpoint: "/graphql",
    landingPage: false,
    schema: buildSchema(),
  })
);

/** Why a request is refused before it is run, or `null` when it may run. */
export function crossSiteRefusal(
  request: Request,
  source: CredentialSource | null
): Response | null {
  const { method } = request;
  if (method !== "GET" && method !== "POST") {
    return problem(
      405,
      "Method Not Allowed",
      "use GET for a query or a subscription, POST for anything",
      {
        allow: "GET, POST",
      }
    );
  }
  const origin = request.headers.get("origin");
  const ownOrigin = new URL(request.url).origin;
  const foreign = origin !== null && origin !== ownOrigin;
  if (foreign && source !== "header") {
    return problem(
      403,
      "Forbidden",
      "a request from another origin must send its own Authorization header"
    );
  }
  if (method === "POST") {
    const media = (request.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (media !== "application/json") {
      return problem(
        415,
        "Unsupported Media Type",
        "a GraphQL POST is application/json"
      );
    }
    if (source === "cookie" && origin !== ownOrigin) {
      return problem(
        403,
        "Forbidden",
        "a POST the cookie authenticates must come from this origin"
      );
    }
  }
  return null;
}

export async function graphqlRoute(
  request: Request,
  env: Env,
  execution: ExecutionContext
): Promise<Response> {
  const { clearCookie, session, source } = await authenticateRequest(
    request,
    env
  );
  const refused = crossSiteRefusal(request, source);
  if (refused !== null) {
    return refused;
  }
  if (session.kind === "invalid") {
    return unauthorized(
      "the key is not valid: it is malformed, unknown, or revoked"
    );
  }
  const context = createContext(env, request, session, execution);
  if (clearCookie) {
    context.cookies.push(signOutCookie());
  }
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
