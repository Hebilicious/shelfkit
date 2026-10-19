/**
 * A value made on first use and kept for the life of the isolate: the engine and the GraphQL schema, which are the
 * same for every request and too costly to build at module scope, where they would count against the Worker's startup
 * limit. Nothing request-specific may be kept this way.
 *
 * A promise that rejects is not kept: the next call makes it again, so one failed start (a module that did not
 * instantiate) does not fail every request the isolate serves.
 */
export function once<T>(make: () => T): () => T {
  let made: Made<T> | undefined;
  return () => {
    if (made === undefined) {
      const kept: Made<T> = { value: make() };
      made = kept;
      if (kept.value instanceof Promise) {
        const settled: Promise<unknown> = kept.value;
        void (async () => {
          try {
            await settled;
          } catch {
            if (made === kept) {
              made = undefined;
            }
          }
        })();
      }
    }
    return made.value;
  };
}

/** What `make` returned, once it has returned. */
interface Made<T> {
  readonly value: T;
}
