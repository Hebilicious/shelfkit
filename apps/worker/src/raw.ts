/**
 * Raw objects: `PUT`, `HEAD`, and `GET` `/raw/{shelf}/objects/{sha256}`. `shelfkit push` uploads each file of a shelf
 * here before it commits the snapshot that names them, and `shelfkit fetch` downloads them. An object is R2's
 * `objects/<sha256>`; the Worker checks the bytes against the hash, so an object is always what its name says. A key
 * reads only objects a committed snapshot of its own shelf references. A shelf the deployment does not hold is
 * answered without creating its object; only the owner's first push creates one.
 */
import { ShelfIdSchema } from "@shelfkit/schema";
import * as v from "valibot";

import { authenticate, existingShelf, shelfStub } from "./auth/index.ts";
import type { Session } from "./auth/index.ts";
import { problem, unauthorized } from "./http.ts";
import {
  isSha256Hex,
  objectKey,
  putObject,
  sha256Hex,
} from "./storage/objects.ts";

/** The largest object a push uploads; the platform's own request limit is 100 MB. */
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

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
  const existing = await existingShelf(env, shelf);
  if (request.method === "PUT") {
    return await upload(request, env, session, existing, shelf, sha256);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return problem(405, "Method Not Allowed", undefined, {
      allow: "GET, HEAD, PUT",
    });
  }
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

/** Store an upload for `shelf`, after checking the session may write it and the bytes are what the path says. */
async function upload(
  request: Request,
  env: Env,
  session: Session,
  existing: Awaited<ReturnType<typeof existingShelf>>,
  shelf: string,
  sha256: string
): Promise<Response> {
  if (session.kind === "anonymous") {
    return unauthorized("uploading needs a key");
  }
  // Only the owner may create a shelf, so only the owner's upload may name one that does not exist yet.
  if (existing === null && session.kind !== "owner") {
    return problem(
      403,
      "Forbidden",
      `this key cannot write to the shelf \`${shelf}\``
    );
  }
  const stub = existing ?? shelfStub(env, shelf);
  if (!(await stub.mayUpload(session, shelf))) {
    return problem(
      403,
      "Forbidden",
      `this key cannot write to the shelf \`${shelf}\``
    );
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_OBJECT_BYTES) {
    return problem(
      413,
      "Content Too Large",
      `an object is at most ${MAX_OBJECT_BYTES} bytes`
    );
  }
  if ((await sha256Hex(bytes)) !== sha256) {
    return problem(
      422,
      "Unprocessable Content",
      "the body's sha256 is not the one in the path"
    );
  }
  await putObject(env.BLOBS, bytes);
  await stub.recordObjects(session, shelf, [{ sha256, size: bytes.length }]);
  return new Response(null, { status: 204 });
}
