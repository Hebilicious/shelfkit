/**
 * The OpenAPM Registry HTTP API at `/apm/v1/...`: a plain fetch handler, because its wire format is fixed by the
 * spec. The Worker routes the request and reads its credential with the engine (`crates/registry`, the code
 * `shelfkit serve` runs), resolves the credential to a session with the auth module, and hands the request to the
 * owner's shelf object, which decides and stores. An archive body streams from R2.
 */
import { authenticate, sessionForKey, shelfStub } from "./auth/index.ts";
import type { Session } from "./auth/index.ts";
import { engine } from "./engine.ts";
import { REGISTRY_MOUNT } from "./shelf-index.ts";
import type { RegistryAnswer } from "./shelf-index.ts";
import { objectKey } from "./storage/objects.ts";

export async function registryRoute(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const shelfEngine = await engine();
  const prepared = shelfEngine.registry.prepare({
    authorization: request.headers.get("authorization") ?? undefined,
    method: request.method,
    mount: REGISTRY_MOUNT,
    path: url.pathname,
  });
  if ("respond" in prepared) {
    return await toResponse(env, {
      body:
        prepared.respond.body.kind === "json"
          ? prepared.respond.body
          : { kind: "empty" },
      headers: prepared.respond.headers,
      status: prepared.respond.status,
    });
  }
  let session: Session;
  if (prepared.credential.kind === "key") {
    session = await sessionForKey(env, prepared.credential.key);
  } else if (prepared.credential.kind === "unreadable") {
    session = { kind: "invalid" };
  } else {
    // No Authorization header: the browser's cookie still counts, as on every other surface.
    session = await authenticate(request, env);
  }
  const body =
    request.method === "PUT"
      ? new Uint8Array(await request.arrayBuffer())
      : undefined;
  const answer = await shelfStub(env, prepared.ownerKey).registry(session, {
    body,
    contentType: request.headers.get("content-type") ?? undefined,
    ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
    method: request.method,
    path: url.pathname,
  });
  return await toResponse(env, answer);
}

/** A registry answer as it crosses the object's RPC boundary, which widens header tuples to arrays. */
type Answer = Omit<RegistryAnswer, "headers"> & {
  readonly headers: readonly (readonly string[])[];
};

async function toResponse(env: Env, answer: Answer): Promise<Response> {
  const headers = new Headers();
  for (const [name = "", value = ""] of answer.headers) {
    headers.append(name, value);
  }
  const { body } = answer;
  if (body.kind === "json") {
    return new Response(body.text, { headers, status: answer.status });
  }
  if (body.kind === "object") {
    const found = await env.BLOBS.get(objectKey(body.sha256));
    if (found === null) {
      throw new Error(`R2 has no object ${objectKey(body.sha256)}`);
    }
    return new Response(found.body, { headers, status: answer.status });
  }
  return new Response(null, { headers, status: answer.status });
}
