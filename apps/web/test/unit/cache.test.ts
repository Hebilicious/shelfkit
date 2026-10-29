import { describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import {
  invalidate,
  keyOf,
  prefetch,
  shelfKey,
  shelfPrefix,
  update,
  useQuery,
} from "../../src/data/cache.ts";

/** Let every pending load finish: each is a chain of already-resolved promises. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each turn waits for the one before it, which is the point.
    await nextTick();
  }
}

describe("the query cache", () => {
  it("serves a second reader of a key from memory, with one load", async () => {
    let loads = 0;
    const load = async (): Promise<string> => {
      loads += 1;
      return await Promise.resolve("answer");
    };
    const scope = effectScope();
    const first = scope.run(() =>
      useQuery(() => keyOf("test", "shared"), load)
    );
    expect(first?.loading.value).toBeTruthy();
    await settled();
    expect(first?.data.value).toBe("answer");
    const second = scope.run(() =>
      useQuery(() => keyOf("test", "shared"), load)
    );
    expect(second?.data.value).toBe("answer");
    expect(second?.loading.value).toBeFalsy();
    await settled();
    expect(loads).toBe(1);
    scope.stop();
  });

  it("keeps the last answer on screen while an invalidated key loads again", async () => {
    let answer = "old";
    const scope = effectScope();
    const query = scope.run(() =>
      useQuery(
        () => shelfKey("one", "list"),
        async () => await Promise.resolve(answer)
      )
    );
    await settled();
    answer = "new";
    invalidate(shelfPrefix("one"));
    expect(query?.data.value).toBe("old");
    expect(query?.loading.value).toBeFalsy();
    await settled();
    expect(query?.data.value).toBe("new");
    scope.stop();
  });

  it("invalidates only the shelf it is given", async () => {
    let loads = 0;
    const scope = effectScope();
    scope.run(() =>
      useQuery(
        () => shelfKey("shelf-two", "list"),
        async () => {
          loads += 1;
          return await Promise.resolve(loads);
        }
      )
    );
    await settled();
    invalidate(shelfPrefix("shelf"));
    await settled();
    expect(loads).toBe(1);
    scope.stop();
  });

  it("switches to another key's answer as soon as the key changes", async () => {
    const id = ref("a");
    prefetch(
      keyOf("test", "item", "b"),
      async () => await Promise.resolve("B")
    );
    await settled();
    const scope = effectScope();
    const query = scope.run(() =>
      useQuery(
        () => keyOf("test", "item", id.value),
        async () => await Promise.resolve(id.value.toUpperCase())
      )
    );
    await settled();
    expect(query?.data.value).toBe("A");
    id.value = "b";
    await nextTick();
    expect(query?.data.value).toBe("B");
    scope.stop();
  });

  it("changes a cached answer in place", async () => {
    const scope = effectScope();
    const query = scope.run(() =>
      useQuery(
        () => keyOf("test", "count"),
        async () => await Promise.resolve(1)
      )
    );
    await settled();
    update<number>(keyOf("test", "count"), (value) => value + 1);
    expect(query?.data.value).toBe(2);
    scope.stop();
  });
});
