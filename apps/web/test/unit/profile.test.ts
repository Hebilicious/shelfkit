import { describe, expect, it } from "vitest";

import {
  addItems,
  emptyProfile,
  moveItem,
  normalizeProfile,
  pinItem,
  placeItem,
  removeItem,
  slugify,
} from "../../src/lib/profile.ts";

const revision = `sha256-${"a".repeat(64)}`;

describe("editing a profile in the composer", () => {
  it("adds items once, in order", () => {
    const profile = addItems(addItems(emptyProfile("p", "P"), ["a", "b"]), [
      "b",
      "c",
    ]);
    expect(profile.items).toStrictEqual(["a", "b", "c"]);
  });

  it("places, moves, pins, and removes by id, pinned or not", () => {
    let profile = addItems(emptyProfile("p", "P"), ["a", "b", "c"]);
    profile = pinItem(profile, "b", revision);
    expect(profile.items).toStrictEqual(["a", `b@${revision}`, "c"]);
    profile = moveItem(profile, "b", -1);
    expect(profile.items).toStrictEqual([`b@${revision}`, "a", "c"]);
    profile = placeItem(profile, "b", 2);
    expect(profile.items).toStrictEqual(["a", "c", `b@${revision}`]);
    profile = placeItem(profile, "d", 0);
    expect(profile.items[0]).toBe("d");
    profile = removeItem(pinItem(profile, "b", null), "b");
    expect(profile.items).toStrictEqual(["d", "a", "c"]);
  });

  it("leaves empty optional fields out of the stored document", () => {
    const profile = normalizeProfile({
      ...emptyProfile("p", "P"),
      compile: { name: "" },
      description: " ",
      version: "",
    });
    expect(profile).toStrictEqual({
      bundles: [],
      compile: {},
      extends: [],
      id: "p",
      items: [],
      title: "P",
    });
  });

  it("makes kebab-case ids from titles", () => {
    expect(slugify("  Web UI: Vue & Workers! ")).toBe("web-ui-vue-workers");
  });
});
