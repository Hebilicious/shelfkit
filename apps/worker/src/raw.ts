/**
 * Raw objects: `HEAD` and `GET` `/raw/{shelf}/objects/{sha256}`, each file of a shelf by its hash, for the browser's
 * engine. An object is R2's `objects/<sha256>`, stored when a commit was indexed. A key reads only objects a committed
 * snapshot of its own shelf references. Files reach a shelf through its Git repository (`src/git.ts`), never here.
 */
import { ShelfIdSchema } from "@shelfkit/schema";
import * as v from "valibot";

import { authenticate, existingShelf } from "./auth/index.ts";
import { problem, unauthorized } from "./http.ts";
import { isSha256Hex, objectKey } from "./storage/objects.ts";

const ROUTE = /^\/raw\/(?<shelf>[^/]+)\/objects\/(?<sha256>[^/]+)$/u;

export async function rawRoute(request: Request, env: Env): Promise<Response> {
  const match = ROUTE.exec(new URL(request.url).pathname)?.groups;
  const shelf = match?.shelf ?? "";
  const sha256 = match?.sha256 ?? "";
  if (!v.is(ShelfIdSchema, shelf) || !isSha256Hex(sha256)) {
    return problem(
      404,
      "Not Found",
      "objects are /raw/{shelf}/objects/{lowercase hex sha256}"
    );
  }
  const session = await authenticate(request, env);
  if (session.kind === "invalid") {
    return unauthorized(
      "the key is not valid: it is malformed, unknown, or revoked"
    );
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return problem(405, "Method Not Allowed", undefined, {
      allow: "GET, HEAD",
    });
  }
  const existing = await existingShelf(env, shelf);
  if (
    existing === null ||
    !(await existing.mayReadObject(session, shelf, sha256))
  ) {
    return session.kind === "anonymous"
      ? unauthorized("reading this shelf needs a key")
      : problem(404, "Not Found", "the shelf references no such object");
  }
  return await serveObject(request.method, env, sha256);
}

/** Answer a `GET` or `HEAD` for an object the session may read. */
async function serveObject(
  method: string,
  env: Env,
  sha256: string
): Promise<Response> {
  const headers = {
    "cache-control": "private, max-age=31536000, immutable",
    etag: `"${sha256}"`,
    // An object is opaque bytes, served as application/octet-stream; a browser must not sniff it into HTML.
    "x-content-type-options": "nosniff",
  };
  if (method === "HEAD") {
    const found = await env.BLOBS.head(objectKey(sha256));
    return found === null
      ? problem(404, "Not Found")
      : new Response(null, {
          headers: { ...headers, "content-length": String(found.size) },
        });
  }
  const found = await env.BLOBS.get(objectKey(sha256));
  return found === null
    ? problem(404, "Not Found")
    : new Response(found.body, {
        headers: { ...headers, "content-type": "application/octet-stream" },
      });
}
