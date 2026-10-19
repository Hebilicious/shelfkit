/**
 * Where a Playwright run listens: the Worker under `wrangler dev`, and the stand-in GitHub. 8792 and 8793 unless
 * `SHELFKIT_E2E_PORT` and `SHELFKIT_E2E_GITHUB_PORT` say otherwise, so two runs on one machine need not collide.
 */
function port(variable: string, fallback: number): number {
  const value = Number(process.env[variable] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(
      `${variable} is not a port: ${process.env[variable] ?? ""}`
    );
  }
  return value;
}

export const PORT = port("SHELFKIT_E2E_PORT", 8792);
export const BASE_URL = `http://localhost:${PORT}`;
export const FAKE_GITHUB_PORT = port("SHELFKIT_E2E_GITHUB_PORT", 8793);
