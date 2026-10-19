#!/usr/bin/env tsx
/**
 * Provision a Cloudflare account for a ShelfKit deployment and deploy it: `moon run worker:setup`.
 *
 * This is the self-hosting path (`docs/PRD.md` section 10.5), and Wrangler is the only tool it drives. In dependency
 * order, and idempotently, so running it again creates nothing that exists:
 *
 * 1. the R2 bucket `shelfkit-blobs`, and a bucket lock that keeps `objects/` immutable: a published revision cannot be
 *    overwritten or deleted at the storage layer either;
 * 2. the queue `shelfkit-jobs` and its dead-letter queue `shelfkit-jobs-dlq`;
 * 3. the owner key, unless the Worker already has one: 32 random bytes, of which the Worker keeps only the SHA-256 as
 *    the secret `OWNER_KEY_HASH`;
 * 4. the deploy, which creates the Durable Object namespace and applies its migrations (`wrangler.jsonc`);
 * 5. a check that `/health` answers.
 *
 * A new owner key is shown once, here, and stored nowhere else. With `--keychain`, it is handed to `shelfkit login`
 * instead, which keeps it in the OS keychain, and it is never printed. Pass the account as `CLOUDFLARE_ACCOUNT_ID` when
 * Wrangler can reach more than one.
 *
 * Options: `--dry-run` (say what would happen), `--keychain` (store a new owner key with `shelfkit login`; the binary
 * is `--shelfkit <path>`, else `shelfkit` on PATH, else `target/debug/shelfkit`), `--rotate-owner-key` (replace it).
 *
 * This is a moon task, not `pnpm setup`: `pnpm setup` is pnpm's own built-in command, and the repository has no npm
 * scripts.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const repository = path.resolve(import.meta.dirname, "..");
const worker = path.join(repository, "apps/worker");
const wranglerBin = path.join(worker, "node_modules/.bin/wrangler");

const BUCKET = "shelfkit-blobs";
const QUEUE = "shelfkit-jobs";
const DEAD_LETTERS = "shelfkit-jobs-dlq";
const OWNER_SECRET = "OWNER_KEY_HASH";
/** The bucket lock: everything under `objects/`, the content-addressed prefix, retained indefinitely. */
const LOCK = {
  rules: [
    {
      condition: { type: "Indefinite" },
      enabled: true,
      id: "objects-immutable",
      prefix: "objects/",
    },
  ],
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const keychain = args.includes("--keychain");
const rotate = args.includes("--rotate-owner-key");
const shelfkitFlag = args.indexOf("--shelfkit");
const shelfkitPath = shelfkitFlag === -1 ? undefined : args[shelfkitFlag + 1];

interface Ran {
  readonly status: number;
  readonly stdout: string;
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
  return { status: ran.status ?? 1, stdout: ran.stdout ?? "" };
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
  step(`Bucket lock on ${BUCKET}/objects/ (indefinite retention)`);
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

/** Whether the deployed Worker already has the owner key's hash. A Worker that does not exist yet has none. */
function hasOwnerKey(): boolean {
  const listed = wrangler(["secret", "list", "--format", "json"], {
    quiet: true,
  });
  if (listed.status !== 0) {
    return false;
  }
  try {
    const secrets: unknown = JSON.parse(listed.stdout);
    return (
      isSecretList(secrets) &&
      secrets.some((secret) => secret.name === OWNER_SECRET)
    );
  } catch {
    return false;
  }
}

/** Deploy, with the owner key's hash when there is a new one, and return the Worker's URLs from Wrangler's output file. */
function deploy(directory: string, ownerKeyHash: string | undefined): string[] {
  step(
    "Deploy the Worker, creating the Durable Object namespace and applying its migrations"
  );
  if (dryRun) {
    console.log("    would deploy");
    return [];
  }
  const output = path.join(directory, "wrangler-output.ndjson");
  const command = ["deploy"];
  if (ownerKeyHash !== undefined) {
    const secrets = path.join(directory, "secrets.json");
    writeFileSync(secrets, JSON.stringify({ [OWNER_SECRET]: ownerKeyHash }), {
      mode: 0o600,
    });
    command.push("--secrets-file", secrets);
  }
  must(
    wrangler(command, { env: { WRANGLER_OUTPUT_FILE_PATH: output } }),
    "deploying"
  );
  const targets: string[] = [];
  for (const line of readFileSync(output, "utf-8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const event: unknown = JSON.parse(line);
    if (isDeployEvent(event)) {
      targets.push(...event.targets);
    }
  }
  return targets;
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

async function main(): Promise<void> {
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

    step("Owner key");
    let ownerKey: string | undefined;
    if (hasOwnerKey() && !rotate) {
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
    const hash =
      ownerKey === undefined
        ? undefined
        : createHash("sha256").update(ownerKey).digest("hex");

    const targets = deploy(directory, dryRun ? undefined : hash);
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
    if (!(await healthy(url))) {
      throw new Error(`${url}/health did not answer`);
    }

    if (ownerKey !== undefined) {
      if (keychain) {
        storeInKeychain(url, ownerKey);
      } else {
        console.log(
          `\nThe owner key, shown this once and stored nowhere (keep it in a password manager, or run \`shelfkit login ${url}\` and paste it):\n\n    ${ownerKey}\n`
        );
      }
    }
    console.log(`\nDone: ${url}`);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

// BOUNDARY: `wrangler secret list --format json` is unknown until this guard has checked each entry's name.
function isSecretList(
  value: unknown
): value is readonly { readonly name: string }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        typeof entry.name === "string"
    )
  );
}

// BOUNDARY: a line of Wrangler's output file is unknown until this guard has found a deploy event with its URLs.
function isDeployEvent(
  value: unknown
): value is { readonly type: "deploy"; readonly targets: readonly string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "deploy" &&
    "targets" in value &&
    Array.isArray(value.targets) &&
    value.targets.every((target: unknown) => typeof target === "string")
  );
}

await main();
