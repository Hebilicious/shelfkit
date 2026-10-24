/**
 * Setup's Artifacts namespace step, without an account: what it reads from Wrangler, and what it decides to do about
 * a namespace that exists, or does not, in a jurisdiction or another.
 */
import { describe, expect, it } from "vitest";

import {
  namespacePlan,
  readAccountIds,
  readJurisdictionOption,
  readNamespace,
  readNamespaceName,
  readToken,
} from "./setup-artifacts.ts";

describe("the Artifacts namespace setup makes", () => {
  it("is created when it does not exist, and kept when it does where it should", () => {
    expect(namespacePlan(null, "eu")).toStrictEqual({ kind: "create" });
    expect(namespacePlan(null)).toStrictEqual({ kind: "create" });
    expect(namespacePlan("eu", "eu")).toStrictEqual({ kind: "keep" });
    expect(namespacePlan("us")).toStrictEqual({ kind: "keep" });
  });

  it("is refused when it exists in another jurisdiction, which cannot change", () => {
    expect(namespacePlan("unrestricted", "eu")).toMatchObject({
      kind: "refuse",
    });
  });

  it("is named by the ARTIFACTS binding in wrangler.jsonc", () => {
    expect(
      readNamespaceName(
        `"artifacts": [{ "binding": "ARTIFACTS", "namespace": "shelfkit", "remote": true }],`
      )
    ).toBe("shelfkit");
  });

  it("takes eu or us, and nothing else", () => {
    expect(readJurisdictionOption("eu")).toBe("eu");
    expect(readJurisdictionOption()).toBeUndefined();
    expect(() => readJurisdictionOption("fr")).toThrow("`eu` or `us`");
  });
});

describe("what setup reads from Wrangler", () => {
  it("reads a namespace's jurisdiction", () => {
    expect(
      readNamespace(
        '{ "namespace": "shelfkit", "jurisdiction": "eu", "repo_count": 0 }'
      )
    ).toBe("eu");
    expect(() => readNamespace("{}")).toThrow("no jurisdiction");
  });

  it("reads the accounts and the login's token", () => {
    expect(
      readAccountIds('{ "accounts": [{ "id": "a1", "name": "One" }] }')
    ).toStrictEqual(["a1"]);
    expect(readToken('{ "type": "oauth", "token": "t" }')).toBe("t");
    expect(() => readToken('{ "type": "oauth" }')).toThrow("no token");
  });
});
