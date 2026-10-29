/**
 * What setup reads from Wrangler and Artifacts' REST API to make sure the Worker's Artifacts namespace exists, in the
 * jurisdiction asked for: pure readers, so `setup-artifacts.test.ts` checks them without an account.
 */

/** Where an Artifacts namespace keeps its repositories' data: anywhere, the EU, or the US. */
export type Jurisdiction = "unrestricted" | "eu" | "us";

/** The jurisdiction `--artifacts-jurisdiction` names, or undefined without it. */
export function readJurisdictionOption(
  value?: string
): "eu" | "us" | undefined {
  if (value === undefined || value === "eu" || value === "us") {
    return value;
  }
  throw new Error("--artifacts-jurisdiction is `eu` or `us`");
}

/** The `ARTIFACTS` binding's namespace in `wrangler.jsonc`'s text. */
export function readNamespaceName(config: string): string {
  const namespace =
    /"binding": "ARTIFACTS", "namespace": "(?<namespace>[^"]+)"/u.exec(config)
      ?.groups?.namespace;
  if (namespace === undefined) {
    throw new Error("wrangler.jsonc has no ARTIFACTS binding");
  }
  return namespace;
}

// BOUNDARY: `wrangler artifacts namespaces get --json` is unknown until this has checked its jurisdiction.
export function readNamespace(stdout: string): Jurisdiction {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(
      "`wrangler artifacts namespaces get --json` printed no JSON"
    );
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "jurisdiction" in value &&
    (value.jurisdiction === "unrestricted" ||
      value.jurisdiction === "eu" ||
      value.jurisdiction === "us")
  ) {
    return value.jurisdiction;
  }
  throw new Error(
    "`wrangler artifacts namespaces get --json` printed no jurisdiction"
  );
}

// BOUNDARY: `wrangler whoami --json` is unknown until this has checked each account's id.
export function readAccountIds(stdout: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("`wrangler whoami --json` printed no JSON");
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "accounts" in value &&
    Array.isArray(value.accounts)
  ) {
    return value.accounts.map((account: unknown) => {
      if (
        typeof account === "object" &&
        account !== null &&
        "id" in account &&
        typeof account.id === "string"
      ) {
        return account.id;
      }
      throw new Error("`wrangler whoami --json` printed an account with no id");
    });
  }
  throw new Error("`wrangler whoami --json` printed no accounts");
}

// BOUNDARY: `wrangler auth token --json` is unknown until this has checked its token.
export function readToken(stdout: string): string {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("`wrangler auth token --json` printed no JSON");
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "token" in value &&
    typeof value.token === "string" &&
    value.token !== ""
  ) {
    return value.token;
  }
  throw new Error("`wrangler auth token --json` printed no token");
}

/**
 * What to do about the namespace: nothing when it exists where it should, create it when it does not, and refuse when
 * it exists in another jurisdiction than the one asked for, since a namespace's jurisdiction cannot change.
 */
export function namespacePlan(
  existing: Jurisdiction | null,
  wanted?: "eu" | "us"
):
  | { readonly kind: "keep" | "create" }
  | { readonly kind: "refuse"; readonly reason: string } {
  if (existing === null) {
    return { kind: "create" };
  }
  if (wanted !== undefined && existing !== wanted) {
    return {
      kind: "refuse",
      reason: `it exists, ${existing}, and a namespace's jurisdiction cannot change: name another namespace in wrangler.jsonc's ARTIFACTS binding`,
    };
  }
  return { kind: "keep" };
}

/** A Wrangler command and what it printed. */
export interface WranglerRun {
  readonly status: number;
  readonly stdout: string;
}

/**
 * Make sure `namespace` exists, in `options.jurisdiction` (anywhere without one), and say what was done. Wrangler has
 * no command that creates a namespace, so this calls Artifacts' REST API with the token of the Wrangler login it runs
 * as (`wrangler auth token`): it makes no token of its own. `account` is asked for only when a namespace is created.
 */
export async function ensureNamespace(
  wrangler: (command: readonly string[]) => WranglerRun,
  account: () => string,
  namespace: string,
  // BOUNDARY: setup's command-line options, named so a call reads as what it asks for.
  options: { readonly dryRun: boolean; readonly jurisdiction?: "eu" | "us" }
): Promise<string> {
  const found = wrangler([
    "artifacts",
    "namespaces",
    "get",
    namespace,
    "--json",
  ]);
  const existing = found.status === 0 ? readNamespace(found.stdout) : null;
  const plan = namespacePlan(existing, options.jurisdiction);
  if (plan.kind === "refuse") {
    throw new Error(`the Artifacts namespace ${namespace}: ${plan.reason}`);
  }
  if (plan.kind === "keep") {
    return `exists, ${existing ?? "unrestricted"}`;
  }
  if (options.dryRun) {
    return "would create it";
  }
  const token = wrangler(["auth", "token", "--json"]);
  if (token.status !== 0) {
    throw new Error("`wrangler auth token` failed: run `wrangler login`");
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account()}/artifacts/namespaces`,
    {
      body: JSON.stringify(
        options.jurisdiction === undefined
          ? { namespace }
          : { jurisdiction: options.jurisdiction, namespace }
      ),
      headers: {
        authorization: `Bearer ${readToken(token.stdout)}`,
        "content-type": "application/json",
      },
      method: "POST",
    }
  );
  if (!response.ok) {
    throw new Error(
      `creating the Artifacts namespace ${namespace} answered ${response.status}: ${await response.text()}`
    );
  }
  return `created, ${options.jurisdiction ?? "unrestricted"}`;
}
