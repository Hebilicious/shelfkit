/**
 * A value made on first use and kept for the life of the isolate: the engine and the GraphQL schema, which are the
 * same for every request and too costly to build at module scope, where they would count against the Worker's startup
 * limit. Nothing request-specific may be kept this way.
 */
export function once<T>(make: () => T): () => T {
  let made: Made<T> | undefined;
  return () => {
    made ??= { value: make() };
    return made.value;
  };
}

/** What `make` returned, once it has returned. */
interface Made<T> {
  readonly value: T;
}
