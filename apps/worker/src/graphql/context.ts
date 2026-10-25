/** What every GraphQL resolver gets: the request's session, the Worker's bindings, and a per-request memo. */
import type { CredentialSource, Session } from "../auth/index.ts";

export interface GraphQLContext {
  readonly env: Env;
  /** Present on the Worker; absent when the schema is printed in Node. */
  readonly execution?: ExecutionContext;
  readonly session: Session;
  /** Where the session's credential came from: the `Authorization` header, the browser's cookie, or nowhere. */
  readonly source: CredentialSource | null;
  readonly request: Request;
  /** `Set-Cookie` values the response carries: `signOut` adds one. */
  readonly cookies: string[];
  /** One answer per key per request, so a field that several objects share is fetched once. */
  readonly memo: <T>(key: string, make: () => Promise<T>) => Promise<T>;
}

export function createContext(
  env: Env,
  request: Request,
  session: Session,
  execution?: ExecutionContext,
  source: CredentialSource | null = null
): GraphQLContext {
  const cache = new Map<string, Promise<unknown>>();
  return {
    cookies: [],
    env,
    execution,
    memo: async <T>(key: string, make: () => Promise<T>): Promise<T> => {
      const found = cache.get(key);
      if (found !== undefined) {
        // SAFETY: each key is only ever filled by `make` for the same `T`; keys name the call that made them.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one cache serves every `T`, so its entries are `Promise<unknown>`; the SAFETY note above is why this one is a `T`.
        return (await found) as T;
      }
      const made = make();
      cache.set(key, made);
      return await made;
    },
    request,
    session,
    source,
  };
}
