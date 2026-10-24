#!/usr/bin/env tsx
/**
 * Provision a Cloudflare account for a ShelfKit deployment and deploy it: `moon run worker:setup`.
 *
 * This is the self-hosting path (`docs/PRD.md` section 10.5), and Wrangler is the only tool it drives. In dependency
 * order, and idempotently, so running it again creates nothing that exists:
 *
 * 1. the R2 bucket `shelfkit-blobs`, and a bucket lock that keeps `archives/` immutable: a published registry
 *    version cannot be overwritten or deleted at the storage layer either;
 * 2. the queue `shelfkit-jobs` and its dead-letter queue `shelfkit-jobs-dlq`, and a report on the Artifacts namespace
 *    that holds each shelf's Git repository: the binding creates it with the first shelf, without a jurisdiction, and
 *    Wrangler cannot create one, so a namespace kept in the EU or the US is made in the dashboard beforehand;
 * 3. the owner key, unless the Worker already has one: 32 random bytes, of which the Worker keeps only the SHA-256 as
 *    the secret `OWNER_KEY_HASH`. Programs use it: the CLI, agents, CI. People sign in with passkeys;
 * 4. the session secret `SESSION_SECRET`, unless the Worker has one: the HMAC key of the browser's session cookie;
 * 5. the deploy, which creates the Durable Object namespaces and applies their migrations (`wrangler.jsonc`);
 * 6. the new secrets, each set with `wrangler secret put` on its standard input. No secret is ever written to a file,
 *    and until they are set the Worker authenticates nobody;
 * 7. a check that `/health` answers;
 * 8. the owner's enrollment: with a new owner key, setup makes a one-time sign-in link and opens it in the browser
 *    (printing it too). The page signs the browser in as the owner and offers to add a passkey there. With an owner
 *    key kept from an earlier run, setup cannot make one, and says to run `shelfkit open`, which uses the key in the
 *    keychain.
 *
 * With `--github-sign-in`, people may also sign in with GitHub, and setup adds two steps:
 *
 * - before the deploy, the owner's GitHub account, `OWNER_GITHUB_ID`, unless the Worker has one: by default the account
 *   `gh api --hostname github.com user` reports on this machine, by numeric id, since a login can change hands and an
 *   id cannot. Setup prints the login and id before it records them;
 * - after `/health`, the deployment's own GitHub App, unless the Worker has `GITHUB_CLIENT_ID` and
 *   `GITHUB_CLIENT_SECRET`. It is made with GitHub's app-manifest flow: a page served on this machine's loopback posts
 *   the manifest to github.com, you click "Create GitHub App", and GitHub sends the browser back to that page with a
 *   code that setup converts into the app's client id and secret, set as Worker secrets on standard input. The app
 *   asks for no permissions, and its callbacks are the deployment's `https:` origins among Wrangler's deploy targets
 *   (`deploymentOrigins`); its private key and webhook secret are never kept. It is public so that accounts the owner
 *   grants access can authorize it; installing it grants nothing.
 *
 * If Wrangler cannot list the Worker's secrets for any reason but the Worker not existing (`Worker "<name>" not
 * found.`), setup stops rather than take that for "no secrets" and replace them.
 *
 * A new owner key is shown once, here, and stored nowhere else. With `--keychain`, it is handed to `shelfkit login`
 * instead, which keeps it in the OS keychain, and it is never printed. Pass the account as `CLOUDFLARE_ACCOUNT_ID` when
 * Wrangler can reach more than one.
 *
 * Options: `--dry-run` (say what would happen), `--keychain` (store a new owner key with `shelfkit login`; the binary
 * is `--shelfkit <path>`, else `shelfkit` on PATH, else `target/debug/shelfkit`), `--rotate-owner-key` (replace it),
 * `--rotate-session-secret` (sign every browser out), `--no-open` (print the enrollment link without opening it),
 * `--no-github-sign-in` (turn GitHub sign-in off: delete its secrets; a run with neither flag leaves it as it is), and
 * with `--github-sign-in`: `--github-owner <login>` (the owner's GitHub account, replacing the one recorded),
 * `--github-org <org>` (create the GitHub App under an organization), `--recreate-github-app` (make a new app).
 *
 * This is a moon task, not `pnpm setup`: `pnpm setup` is pnpm's own built-in command, and the repository has no npm
 * scripts.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  callbackUrl,
  deployCommand,
  enrollmentMessage,
  deploymentOrigins,
  isAddressInfo,
  loopbackHandler,
  OWNER_LOOKUP,
  readSecretListing,
  readSignInLink,
  SIGN_IN_LINK,
} from "./setup-github.ts";

const repository = path.resolve(import.meta.dirname, "..");
const worker = path.join(repository, "apps/worker");
const wranglerBin = path.join(worker, "node_modules/.bin/wrangler");

const BUCKET = "shelfkit-blobs";
const QUEUE = "shelfkit-jobs";
const DEAD_LETTERS = "shelfkit-jobs-dlq";
const OWNER_SECRET = "OWNER_KEY_HASH";
const SESSION_SECRET = "SESSION_SECRET";
const OWNER_GITHUB = "OWNER_GITHUB_ID";
const CLIENT_ID = "GITHUB_CLIENT_ID";
const CLIENT_SECRET = "GITHUB_CLIENT_SECRET";
/** How long setup waits for you to create the GitHub App on github.com. */
const GITHUB_APP_WAIT_MS = 15 * 60 * 1000;
/**
 * The bucket lock: published registry archives (`archives/`), retained indefinitely. Uploaded content (`objects/`) is
 * not locked: an upload no commit takes must stay removable. Setting the configuration replaces any earlier rule, so
 * a deployment that locked `objects/` (the rule `objects-immutable`) loses that rule here.
 */
const LOCK = {
  rules: [
    {
      condition: { type: "Indefinite" },
      enabled: true,
      id: "archives-immutable",
      prefix: "archives/",
    },
  ],
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const keychain = args.includes("--keychain");
const rotate = args.includes("--rotate-owner-key");
const rotateSession = args.includes("--rotate-session-secret");
const recreateApp = args.includes("--recreate-github-app");
const githubSignIn = args.includes("--github-sign-in");
const noGithubSignIn = args.includes("--no-github-sign-in");
const noOpen = args.includes("--no-open");

/** The value after `flag`, when it was given. */
function option(flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

const shelfkitPath = option("--shelfkit");
const githubOwner = option("--github-owner");
const githubOrg = option("--github-org");

interface Ran {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run Wrangler in the Worker's directory. Its output is shown unless `quiet`; the exit code is returned. */
function wrangler(
  command: readonly string[],
  options: {
    readonly quiet?: boolean;
    readonly env?: Record<string, string>;
    readonly input?: string;
  } = {}
): Ran {
  const ran = spawnSync(wranglerBin, command, {
    cwd: worker,
    encoding: "utf-8",
    env: { ...process.env, ...options.env },
    input: options.input,
    stdio: [
      options.input === undefined ? "inherit" : "pipe",
      options.quiet === true ? "pipe" : "inherit",
      // A quiet command is a probe whose exit code is the answer, so its error output is not the user's business.
      options.quiet === true ? "pipe" : "inherit",
    ],
  });
  if (ran.error !== undefined) {
    throw ran.error;
  }
  return {
    status: ran.status ?? 1,
    stderr: ran.stderr ?? "",
    stdout: ran.stdout ?? "",
  };
}

function must(ran: Ran, what: string): void {
  if (ran.status !== 0) {
    throw new Error(`${what} failed (wrangler exited ${ran.status})`);
  }
}

function step(title: string): void {
  console.log(`\n==> ${title}`);
}

function ensureBucket(): void {
  step(`R2 bucket ${BUCKET}`);
  if (
    wrangler(["r2", "bucket", "info", BUCKET, "--json"], { quiet: true })
      .status === 0
  ) {
    console.log("    exists");
    return;
  }
  if (dryRun) {
    console.log("    would create it");
    return;
  }
  must(wrangler(["r2", "bucket", "create", BUCKET]), `creating ${BUCKET}`);
}

function ensureLock(directory: string): void {
  step(
    `Bucket lock on ${BUCKET}/archives/ (published archives, indefinite retention)`
  );
  if (dryRun) {
    console.log("    would set it");
    return;
  }
  const file = path.join(directory, "lock.json");
  writeFileSync(file, JSON.stringify(LOCK));
  // Setting the whole configuration is idempotent: a second run sets the same single rule.
  must(
    wrangler([
      "r2",
      "bucket",
      "lock",
      "set",
      BUCKET,
      "--file",
      file,
      "--force",
    ]),
    "setting the bucket lock"
  );
}

function ensureQueue(name: string): void {
  step(`Queue ${name}`);
  if (wrangler(["queues", "info", name], { quiet: true }).status === 0) {
    console.log("    exists");
    return;
  }
  if (dryRun) {
    console.log("    would create it");
    return;
  }
  must(wrangler(["queues", "create", name]), `creating the queue ${name}`);
}

/** The Artifacts namespace the Worker's `ARTIFACTS` binding names in `wrangler.jsonc`. */
function artifactsNamespace(): string {
  const config = readFileSync(path.join(worker, "wrangler.jsonc"), "utf-8");
  const namespace =
    /"binding": "ARTIFACTS", "namespace": "(?<namespace>[^"]+)"/u.exec(config)
      ?.groups?.namespace;
  if (namespace === undefined) {
    throw new Error("wrangler.jsonc has no ARTIFACTS binding");
  }
  return namespace;
}

/** Say where shelves' repositories will live. Nothing is created: the binding makes the namespace when it needs it. */
function reportArtifacts(): void {
  const namespace = artifactsNamespace();
  step(`Artifacts namespace ${namespace}, for each shelf's Git repository`);
  const found = wrangler(
    ["artifacts", "namespaces", "get", namespace, "--json"],
    { quiet: true }
  );
  if (found.status !== 0) {
    console.log(
      "    not there yet: the first shelf creates it, with no jurisdiction. To keep repositories in the EU or the US, create it now in the dashboard (Storage & databases > Artifacts) with that jurisdiction; it cannot change later"
    );
    return;
  }
  const jurisdiction = /"jurisdiction":\s*"(?<value>[^"]+)"/u.exec(found.stdout)
    ?.groups?.value;
  console.log(
    `    exists${jurisdiction === undefined ? "" : `, in the ${jurisdiction} jurisdiction`}`
  );
}

/** The Worker's name: the top-level `name` in `wrangler.jsonc`, which Wrangler names it by in its errors. */
function workerName(): string {
  const config = readFileSync(path.join(worker, "wrangler.jsonc"), "utf-8");
  const name = /^ {2}"name": "(?<name>[^"]+)",?$/mu.exec(config)?.groups?.name;
  if (name === undefined) {
    throw new Error("wrangler.jsonc has no top-level `name`");
  }
  return name;
}

/** The names of the deployed Worker's secrets: none when the Worker does not exist yet. Any other failure stops setup. */
function workerSecrets(): ReadonlySet<string> {
  const listing = readSecretListing(
    wrangler(["secret", "list", "--format", "json"], { quiet: true }),
    workerName()
  );
  return listing.kind === "listed" ? listing.names : new Set();
}

/** Deploy, and return the origins the Worker answers on (`deploymentOrigins`). No secret goes with it (`deployCommand`). */
function deploy(directory: string): string[] {
  step(
    "Deploy the Worker, creating the Durable Object namespace and applying its migrations"
  );
  if (dryRun) {
    console.log("    would deploy");
    return [];
  }
  const output = path.join(directory, "wrangler-output.ndjson");
  must(
    wrangler(deployCommand(), { env: { WRANGLER_OUTPUT_FILE_PATH: output } }),
    "deploying"
  );
  return deploymentOrigins(readFileSync(output, "utf-8"));
}

async function healthy(url: string): Promise<boolean> {
  step(`Health: ${url}/health`);
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a new workers.dev route takes a few seconds to answer.
      const response = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the answer that ends the loop.
        console.log(`    ${await response.text()}`);
        return true;
      }
    } catch {
      // Not answering yet.
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- waiting between bounded attempts.
    await sleep(3000);
  }
  return false;
}

function shelfkitBinary(): string {
  if (shelfkitPath !== undefined) {
    return shelfkitPath;
  }
  const found = spawnSync("shelfkit", ["--version"], { stdio: "ignore" });
  if (found.status === 0) {
    return "shelfkit";
  }
  const built = path.join(repository, "target/debug/shelfkit");
  if (existsSync(built)) {
    return built;
  }
  throw new Error(
    "--keychain needs the shelfkit binary: pass --shelfkit <path>, or `moon run compiler:build` first"
  );
}

/** Hand the owner key to `shelfkit login` on its standard input, so it reaches the keychain without being printed. */
function storeInKeychain(url: string, key: string): void {
  step("Store the owner key in the OS keychain with `shelfkit login`");
  const ran = spawnSync(shelfkitBinary(), ["login", url], {
    encoding: "utf-8",
    input: `${key}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (ran.status !== 0) {
    throw new Error(
      "`shelfkit login` failed; run setup again with --rotate-owner-key to make a new owner key"
    );
  }
}

/** A GitHub account, as the REST API reports it. */
interface GitHubAccount {
  readonly id: number;
  readonly login: string;
}

// BOUNDARY: a GitHub REST answer is unknown until this guard has found an account's numeric id and login.
function isAccount(value: unknown): value is GitHubAccount {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number" &&
    "login" in value &&
    typeof value.login === "string"
  );
}

/** The account `--github-owner` names, from GitHub's public API, or the one `gh` is signed in as on this machine. */
async function ownerAccount(): Promise<GitHubAccount> {
  if (githubOwner !== undefined) {
    const login = githubOwner.replace(/^@/u, "");
    const answer = await fetch(
      `https://api.github.com/users/${encodeURIComponent(login)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "shelfkit-setup",
        },
      }
    );
    const account: unknown = answer.ok ? await answer.json() : null;
    if (!isAccount(account)) {
      throw new Error(
        `GitHub has no account \`${login}\` (it answered ${answer.status})`
      );
    }
    return account;
  }
  const ran = spawnSync("gh", OWNER_LOOKUP, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const account: unknown =
    ran.status === 0 ? JSON.parse(ran.stdout || "null") : null;
  if (!isAccount(account)) {
    throw new Error(
      "could not ask `gh api --hostname github.com user` who you are: sign in with `gh auth login --hostname github.com`, or pass --github-owner <login>"
    );
  }
  return account;
}

/** The app GitHub made from the manifest: what setup keeps of it. */
interface CreatedApp {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly slug: string;
  readonly htmlUrl: string;
}

// BOUNDARY: the manifest conversion's answer is unknown until this guard has found the fields setup keeps. The rest of
// it, the private key and the webhook secret included, is never read.
function isConversion(value: unknown): value is {
  readonly client_id: string;
  readonly client_secret: string;
  readonly slug: string;
  readonly html_url: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "client_id" in value &&
    typeof value.client_id === "string" &&
    "client_secret" in value &&
    typeof value.client_secret === "string" &&
    "slug" in value &&
    typeof value.slug === "string" &&
    "html_url" in value &&
    typeof value.html_url === "string"
  );
}

/** Open a URL in the default browser, if this machine has one; the URL is printed either way. */
async function openBrowser(url: string): Promise<boolean> {
  let command = "xdg-open";
  let rest = [url];
  if (process.platform === "darwin") {
    command = "open";
  } else if (process.platform === "win32") {
    command = "cmd";
    rest = ["/c", "start", "", url];
  }
  try {
    const child = spawn(command, rest, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // `spawn` once the program started; `once` rejects on `error`, when there is no such program.
    await once(child, "spawn");
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the deployment's GitHub App with GitHub's app-manifest flow, through a page on this machine's loopback, and
 * return its client id and secret. Nothing of it is written to disk.
 */
async function createGitHubApp(
  deployments: readonly string[]
): Promise<CreatedApp> {
  const state = randomBytes(24).toString("hex");
  // The loopback page receives the code GitHub sends back, and closes the server, which ends the wait below.
  let code = "";
  let page = "";
  const server = createServer(
    loopbackHandler({
      created: (received) => {
        code = received;
        server.close();
        server.closeAllConnections();
      },
      deployments,
      page: () => page,
      state,
      target:
        githubOrg === undefined
          ? "https://github.com/settings/apps/new"
          : `https://github.com/organizations/${encodeURIComponent(githubOrg)}/settings/apps/new`,
    })
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new Error("could not open a loopback port for the GitHub App page");
  }
  page = `http://127.0.0.1:${address.port}/`;
  console.log(
    `    open ${page} and click "Create GitHub App" on github.com (waiting up to 15 minutes)`
  );
  void openBrowser(page);
  try {
    await once(server, "close", {
      signal: AbortSignal.timeout(GITHUB_APP_WAIT_MS),
    });
  } catch {
    server.close();
    server.closeAllConnections();
    throw new Error("the GitHub App was not created in 15 minutes");
  }
  const answer = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "shelfkit-setup",
      },
      method: "POST",
    }
  );
  const converted: unknown = answer.ok ? await answer.json() : null;
  if (!isConversion(converted)) {
    throw new Error(
      `GitHub did not convert the app manifest (it answered ${answer.status})`
    );
  }
  return {
    clientId: converted.client_id,
    clientSecret: converted.client_secret,
    htmlUrl: converted.html_url,
    slug: converted.slug,
  };
}

/** A new `SESSION_SECRET`, unless the Worker has one and it is not being rotated. */
function sessionSecret(
  existing: ReadonlySet<string>
): Partial<Record<typeof SESSION_SECRET, string>> {
  step("Session secret, which signs the browser's session cookie");
  if (existing.has(SESSION_SECRET) && !rotateSession) {
    console.log(
      `    the Worker has ${SESSION_SECRET}; keeping it (--rotate-session-secret replaces it and signs every browser out)`
    );
    return {};
  }
  console.log(dryRun ? "    would make one" : "    made a new one");
  return { [SESSION_SECRET]: randomBytes(32).toString("base64url") };
}

/** The owner's GitHub account id, unless the Worker has one and `--github-owner` does not replace it. */
async function ownerGitHub(
  existing: ReadonlySet<string>
): Promise<Partial<Record<typeof OWNER_GITHUB, string>>> {
  step("Owner's GitHub account: signing in with it is signing in as the owner");
  if (existing.has(OWNER_GITHUB) && githubOwner === undefined) {
    console.log(
      `    the Worker has ${OWNER_GITHUB}; keeping it (--github-owner <login> replaces it)`
    );
    return {};
  }
  const owner = await ownerAccount();
  console.log(
    `    @${owner.login} (id ${owner.id})${githubOwner === undefined ? "; pass --github-owner <login> to choose another account" : ""}`
  );
  return { [OWNER_GITHUB]: String(owner.id) };
}

/** The GitHub App's client id and secret, unless the Worker has them and `--recreate-github-app` was not given. */
async function ensureGitHubApp(
  existing: ReadonlySet<string>,
  deployments: readonly string[]
): Promise<void> {
  step(
    `GitHub App for "Sign in with GitHub" (callbacks ${deployments.length === 0 ? "for each address the deploy reports" : deployments.map(callbackUrl).join(", ")})`
  );
  if (existing.has(CLIENT_ID) && existing.has(CLIENT_SECRET) && !recreateApp) {
    console.log(
      `    the Worker has ${CLIENT_ID} and ${CLIENT_SECRET}; keeping them (--recreate-github-app makes a new app)`
    );
    return;
  }
  if (dryRun) {
    console.log("    would create one through github.com, after the deploy");
    return;
  }
  const app = await createGitHubApp(deployments);
  putSecret(CLIENT_ID, app.clientId);
  putSecret(CLIENT_SECRET, app.clientSecret);
  console.log(
    `    created ${app.slug}: ${app.htmlUrl} (its private key and webhook secret were not kept)`
  );
}

/** Set the new secrets on the deployed Worker, each on Wrangler's standard input: none is written to a file. */
function setSecrets(secrets: Readonly<Record<string, string>>): void {
  const names = Object.keys(secrets);
  if (names.length === 0) {
    return;
  }
  step(`Secrets: ${names.join(", ")}`);
  for (const [name, value] of Object.entries(secrets)) {
    putSecret(name, value);
  }
}

/**
 * Sign the owner's browser in: a one-time link, made with the new owner key, opened in the browser and printed. The
 * page it opens offers to add a passkey on that device.
 */
async function enrollOwner(url: string, ownerKey: string): Promise<void> {
  step("Owner's browser: a one-time sign-in link, to add a passkey");
  const answer = await fetch(`${url}/graphql`, {
    body: JSON.stringify({ query: SIGN_IN_LINK }),
    headers: {
      authorization: `Bearer ${ownerKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const link = readSignInLink(await answer.text());
  const opened = noOpen ? false : await openBrowser(link.url);
  console.log(enrollmentMessage({ ...link, noOpen, opened }));
}

/**
 * Turn GitHub sign-in off: delete the secrets that enable it. Every GitHub session, the owner's included, ends at its
 * next request, and GitHub accounts' grants hold nothing. The GitHub App itself stays on github.com; delete it there.
 */
function removeGitHubSignIn(existing: ReadonlySet<string>): void {
  step("GitHub sign-in: turning it off");
  const present = [CLIENT_ID, CLIENT_SECRET, OWNER_GITHUB].filter((name) =>
    existing.has(name)
  );
  if (present.length === 0) {
    console.log("    it was off already");
    return;
  }
  for (const name of present) {
    // An empty standard input makes Wrangler take its non-interactive answer to "are you sure": yes.
    must(
      wrangler(["secret", "delete", name], { input: "", quiet: true }),
      `deleting the secret ${name}`
    );
  }
  console.log(
    `    deleted ${present.join(", ")}; delete the GitHub App on github.com too (Settings, Developer settings, GitHub Apps)`
  );
}

/** `wrangler secret put`, with the value on its standard input, so it is neither printed nor written to disk. */
function putSecret(name: string, value: string): void {
  must(
    wrangler(["secret", "put", name], { input: value, quiet: true }),
    `setting the secret ${name}`
  );
}

async function main(): Promise<void> {
  if (githubSignIn && noGithubSignIn) {
    throw new Error(
      "--github-sign-in and --no-github-sign-in contradict each other"
    );
  }
  const directory = mkdtempSync(path.join(tmpdir(), "shelfkit-setup-"));
  try {
    step("Wrangler's account");
    must(
      wrangler(["whoami"], { quiet: true }),
      "`wrangler whoami` (run `wrangler login` first)"
    );
    console.log(
      `    ${process.env.CLOUDFLARE_ACCOUNT_ID === undefined ? "the account Wrangler chooses" : `account ${process.env.CLOUDFLARE_ACCOUNT_ID}`}`
    );

    ensureBucket();
    ensureLock(directory);
    ensureQueue(DEAD_LETTERS);
    ensureQueue(QUEUE);
    reportArtifacts();

    const existing = workerSecrets();
    const secrets: Record<string, string> = {};

    step("Owner key, for programs: the CLI, agents, CI");
    let ownerKey: string | undefined;
    if (existing.has(OWNER_SECRET) && !rotate) {
      console.log(
        `    the Worker has ${OWNER_SECRET}; keeping it (--rotate-owner-key replaces it)`
      );
    } else {
      ownerKey = `sko_${randomBytes(32).toString("base64url")}`;
      console.log(
        dryRun
          ? "    would make one"
          : "    made a new one; the Worker keeps only its SHA-256"
      );
    }
    if (ownerKey !== undefined) {
      secrets[OWNER_SECRET] = createHash("sha256")
        .update(ownerKey)
        .digest("hex");
    }

    Object.assign(secrets, sessionSecret(existing));
    if (githubSignIn) {
      Object.assign(secrets, await ownerGitHub(existing));
    }

    const targets = deploy(directory);
    if (dryRun && githubSignIn) {
      await ensureGitHubApp(existing, []);
    }
    const [url] = targets;
    if (dryRun) {
      console.log("\nDry run: nothing was created or deployed.");
      return;
    }
    if (url === undefined) {
      throw new Error(
        "Wrangler reported no URL for the Worker; check `workers_dev` in wrangler.jsonc"
      );
    }
    setSecrets(secrets);
    if (!(await healthy(url))) {
      throw new Error(`${url}/health did not answer`);
    }

    if (githubSignIn) {
      await ensureGitHubApp(existing, targets);
    }
    if (noGithubSignIn) {
      removeGitHubSignIn(existing);
    }

    if (ownerKey === undefined) {
      step("Owner's browser");
      console.log(
        `    the owner key was kept from an earlier run, so setup cannot sign a browser in: run \`shelfkit open ${url}\`, which uses the key in your keychain`
      );
    } else {
      if (keychain) {
        storeInKeychain(url, ownerKey);
      } else {
        console.log(
          `\nThe owner key, for programs, shown this once and stored nowhere (keep it in a password manager, or run \`shelfkit login ${url}\` and paste it):\n\n    ${ownerKey}\n`
        );
      }
      await enrollOwner(url, ownerKey);
    }
    console.log(`\nDone: ${url}`);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

await main();
