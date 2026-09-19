#!/usr/bin/env tsx
/**
 * Provisions a Cloudflare account for a ShelfKit deployment.
 *
 * This is the primary self-hosting path, not a convenience wrapper: it creates
 * the resources in dependency order, writes secrets, applies migrations, and
 * deploys. See docs/PRD.md section 10.5.
 */
import { execFileSync } from "node:child_process";

interface Step {
  title: string;
  run: () => void;
}

function sh(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: "inherit" });
}

/** Run a binary from the Worker's node_modules, resolved through pnpm exec. */
function wrangler(args: string[]): void {
  sh("pnpm", ["--filter", "@shelfkit/worker", "exec", "wrangler", ...args]);
}

const steps: Step[] = [
  {
    title: "Create the R2 bucket",
    run: () => wrangler(["r2", "bucket", "create", "shelfkit-blobs"]),
  },
  {
    title: "Create the job queue and its dead-letter queue",
    run: () => {
      wrangler(["queues", "create", "shelfkit-jobs"]);
      wrangler(["queues", "create", "shelfkit-jobs-dlq"]);
    },
  },
  {
    title: "Deploy, which creates the Durable Object namespace and its migrations",
    run: () => wrangler(["deploy"]),
  },
];

function main(): void {
  const dryRun = process.argv.includes("--dry-run");

  for (const step of steps) {
    console.log(`\n==> ${step.title}`);
    if (dryRun) {
      console.log("    (dry run, skipped)");
      continue;
    }
    step.run();
  }

  console.log("\nDone. Set secrets with `moon run worker:secret -- <NAME>`.");
}

main();
