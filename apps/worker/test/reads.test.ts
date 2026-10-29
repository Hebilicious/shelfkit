/**
 * What a shelf's reads cost: an unknown shelf is answered by its object without R2 and leaves no storage behind, an
 * object that is up to date does not migrate again, and the web UI's shelf index query is one detail call for a page.
 */
import {
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";

import type { Session } from "../src/auth/index.ts";
import { migrateDatabase, SCHEMA_VERSION } from "../src/db/migrate.ts";
import { ShelfIndex } from "../src/shelf-index.ts";
import { createKey, data, fixtureShelf, graphql, push } from "./helpers.ts";

const owner: Session = { keyId: "owner", kind: "owner" };

function stub(shelf: string) {
  return env.SHELF.get(env.SHELF.idFromName(shelf));
}

/** The tables of an object's database, its own and the migrator's. */
function tables(state: DurableObjectState): string[] {
  return state.storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' ORDER BY name"
    )
    .toArray()
    .map((row) => row.name);
}

/** Every test starts from empty storage, with no object awake. */
async function fresh(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
}

describe("a shelf the deployment does not hold", () => {
  beforeEach(fresh);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is null to GraphQL without asking R2, and its object stores nothing", async () => {
    const head = vi.spyOn(env.BLOBS, "head");
    const answer = await data(
      v.object({ shelf: v.null() }),
      `{ shelf(id: "nowhere") { id items { total } } }`
    );
    expect(answer.shelf).toBeNull();
    expect(head).not.toHaveBeenCalled();
    // Miniflare lists every object a request woke, written to or not; what matters is that this one holds nothing.
    const stored = await runInDurableObject(
      stub("nowhere"),
      (_instance: ShelfIndex, state) => tables(state)
    );
    expect(stored).toStrictEqual([]);
  });

  it("is answered by an object that writes nothing, a key's lookup included", async () => {
    const found = await runInDurableObject(
      stub("nowhere"),
      (instance: ShelfIndex, state) => ({
        effective: instance.effectiveSession({
          kind: "person",
          person: { id: "person:someone", name: "Someone" },
        }),
        key: instance.resolveKey("0".repeat(64)),
        summary: instance.summary(owner, "nowhere"),
        tables: tables(state),
      })
    );
    expect(found.summary.ok).toBeFalsy();
    expect(found.key).toBeNull();
    expect(found.effective).toStrictEqual({ kind: "anonymous" });
    expect(found.tables).toStrictEqual([]);
  });

  it("is created, migrated, by its first push", async () => {
    const pushed = await push(
      "fresh",
      fixtureShelf(inject("allKindsShelf"), "fresh")
    );
    expect(pushed.errors).toStrictEqual([]);
    const version = await runInDurableObject(
      stub("fresh"),
      (_instance: ShelfIndex, state) =>
        state.storage.sql
          .exec<{ value: string }>(
            "SELECT value FROM meta WHERE key = 'schema_version'"
          )
          .one().value
    );
    expect(Number(version)).toBe(SCHEMA_VERSION);
  });
});

describe("the migration on wake", () => {
  beforeEach(fresh);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs nothing when the database records this code's schema version", async () => {
    const after = await runInDurableObject(
      stub("probe"),
      (_instance: ShelfIndex, state) => {
        // A database that says it is current but has none of the migrations' tables: running the migrator would
        // make them.
        state.storage.sql.exec(
          "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        );
        state.storage.sql.exec(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
          String(SCHEMA_VERSION)
        );
        migrateDatabase(state.storage);
        return tables(state);
      }
    );
    expect(after).toStrictEqual(["meta"]);
  });
});

const ShelfIndexQuery = `query ShelfIndex($shelf: ID!, $offset: Int) { shelf(id: $shelf) { id name description public registryUrl defaultProfile itemCount profileCount viewerAccess { owner member read write profiles } recents(limit: 8) { usedAt uses item { id } } items(limit: 200, offset: $offset) { total nodes { item { id kind title description tags targets revision updatedAt scanStatus favourite body variables asCommand document source coordinate { kind entry name message } drift { status } dependents { requiredBy recommendedBy bundles profiles } } } } } }`;

const IndexedItem = v.object({
  body: v.nullable(v.string()),
  dependents: v.object({
    bundles: v.array(v.string()),
    profiles: v.array(v.string()),
    recommendedBy: v.array(v.string()),
    requiredBy: v.array(v.string()),
  }),
  favourite: v.boolean(),
  id: v.string(),
  kind: v.string(),
  scanStatus: v.string(),
});

const IndexAnswer = v.object({
  shelf: v.object({
    items: v.object({
      nodes: v.array(v.object({ item: IndexedItem })),
      total: v.number(),
    }),
    recents: v.array(v.object({ item: v.object({ id: v.string() }) })),
  }),
});

/** Push the all-kinds fixture as `kit`, and favourite one prompt as a reader key; the key's secret. */
async function readerOfKit(): Promise<string> {
  const pushed = await push(
    "kit",
    fixtureShelf(inject("allKindsShelf"), "kit")
  );
  if (pushed.errors.length > 0) {
    throw new Error(JSON.stringify(pushed.errors));
  }
  const key = await createKey("kit", ["read"], "reader");
  await data(
    v.unknown(),
    `mutation { setFavourite(shelf: "kit", item: "pr-description", favourite: true) }`,
    {},
    key.secret
  );
  return key.secret;
}

async function shelfIndex(key: string) {
  const answer = await graphql(ShelfIndexQuery, { shelf: "kit" }, key);
  if (answer.errors !== undefined) {
    throw new Error(JSON.stringify(answer.errors));
  }
  const index = v.parse(IndexAnswer, answer.data);
  return {
    byId: new Map(
      index.shelf.items.nodes.map((node) => [node.item.id, node.item])
    ),
    total: index.shelf.items.total,
  };
}

describe("the web UI's shelf index query", () => {
  beforeEach(fresh);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches every item's detail and body in one call each, and asks R2 nothing", async () => {
    const key = await readerOfKit();
    const details = vi.spyOn(ShelfIndex.prototype, "itemDetails");
    const bodies = vi.spyOn(ShelfIndex.prototype, "itemBodies");
    const single = vi.spyOn(ShelfIndex.prototype, "itemDetail");
    const head = vi.spyOn(env.BLOBS, "head");
    const index = await shelfIndex(key);
    expect(index.total).toBe(14);
    expect(details).toHaveBeenCalledOnce();
    expect(bodies).toHaveBeenCalledOnce();
    expect(single).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  });

  it("gives each item its own favourite, dependents, and body", async () => {
    const { byId } = await shelfIndex(await readerOfKit());
    expect(
      [...byId.values()].filter((item) => item.favourite).map((item) => item.id)
    ).toStrictEqual(["pr-description"]);
    expect(
      [...byId.values()]
        .filter((item) => item.dependents.bundles.includes("code-quality"))
        .map((item) => item.id)
        .toSorted()
    ).toStrictEqual(["format-on-save", "review-checklist"]);
    const prompt = await stub("kit").getItem(owner, "kit", "pr-description");
    expect(byId.get("pr-description")?.body).toBe(
      prompt.ok
        ? prompt.value.files.find((file) => file.path === "prompt.md")?.contents
        : "missing"
    );
    expect(byId.get("linear")?.body).toBeNull();
  });

  it("answers for each item what `item(id:)` answers for it alone", async () => {
    const key = await readerOfKit();
    const { byId } = await shelfIndex(key);
    const alone = await Promise.all(
      [...byId.keys()].map(async (id) => {
        const found = await data(
          v.object({ shelf: v.object({ item: IndexedItem }) }),
          `query One($id: ID!) { shelf(id: "kit") { item(id: $id) { id kind body favourite scanStatus dependents { requiredBy recommendedBy bundles profiles } } } }`,
          { id },
          key
        );
        return found.shelf.item;
      })
    );
    expect(alone).toStrictEqual([...byId.values()]);
  });
});
