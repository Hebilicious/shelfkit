/**
 * Where a Playwright run listens: the Worker under `wrangler dev` (passkeys and links, the default), a second Worker
 * with GitHub sign-in enabled, and the stand-in GitHub. Each run takes ports the system reports free when it starts,
 * so runs in two worktrees, or two at once in one, never collide. `SHELFKIT_E2E_PORT`, `SHELFKIT_E2E_GITHUB_PORT`, and
 * `SHELFKIT_E2E_GITHUB_WORKER_PORT` fix them instead.
 *
 * The first process to load this module, Playwright's runner, chooses the ports and puts them in its environment, which
 * the workers it starts and the servers it runs inherit, so every process of the run agrees on them.
 */
import { execFileSync } from "node:child_process";

const VARIABLES = [
  "SHELFKIT_E2E_PORT",
  "SHELFKIT_E2E_GITHUB_PORT",
  "SHELFKIT_E2E_GITHUB_WORKER_PORT",
] as const;

/**
 * `count` distinct ports nothing listens on: the system's choice for a listener on port 0, held open until all are
 * chosen so none is chosen twice. A child process asks, because a module's top level cannot wait for a listener.
 */
function freePorts(count: number): string[] {
  const script = `
    const net = require("node:net");
    const servers = Array.from({ length: ${count} }, () => net.createServer());
    Promise.all(
      servers.map((server) => new Promise((resolve) => server.listen(0, "localhost", () => resolve(server.address().port))))
    ).then((ports) => {
      process.stdout.write(ports.join(" "));
      for (const server of servers) server.close();
    });
  `;
  return execFileSync(process.execPath, ["-e", script], { encoding: "utf-8" })
    .trim()
    .split(" ");
}

const unset = VARIABLES.filter(
  (variable) => process.env[variable] === undefined
);
if (unset.length > 0) {
  const chosen = freePorts(unset.length);
  for (const [index, variable] of unset.entries()) {
    process.env[variable] = chosen[index];
  }
}

function port(variable: (typeof VARIABLES)[number]): number {
  const value = Number(process.env[variable]);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(
      `${variable} is not a port: ${process.env[variable] ?? ""}`
    );
  }
  return value;
}

export const PORT = port("SHELFKIT_E2E_PORT");
export const BASE_URL = `http://localhost:${PORT}`;
export const FAKE_GITHUB_PORT = port("SHELFKIT_E2E_GITHUB_PORT");
export const GITHUB_WORKER_PORT = port("SHELFKIT_E2E_GITHUB_WORKER_PORT");
export const GITHUB_BASE_URL = `http://localhost:${GITHUB_WORKER_PORT}`;
