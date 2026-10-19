/**
 * Where the browser may be sent back to after signing in: a path on this origin, or `/`. The Worker checks `next`
 * the same way (`apps/worker/src/auth/github.ts`, `localPath`); this copy keeps the SPA from even asking for another.
 */

/** Characters `next` may never hold: controls, space, and `\`, which browsers read as `/` or drop from a URL. */
// oxlint-disable-next-line eslint/no-control-regex -- matching control characters is the point: `next` may hold none.
const UNSAFE_PATH = /[\u0000- \u007F\\]/u;

export function localPath(
  next: string | null | undefined,
  origin: string
): string {
  if (
    next === null ||
    next === undefined ||
    !next.startsWith("/") ||
    UNSAFE_PATH.test(next)
  ) {
    return "/";
  }
  let resolved: URL;
  try {
    resolved = new URL(next, origin);
  } catch {
    return "/";
  }
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  if (
    resolved.origin !== origin ||
    path.startsWith("//") ||
    path.startsWith("/auth/")
  ) {
    return "/";
  }
  return path;
}
