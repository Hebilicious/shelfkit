/** Small HTTP helpers shared by the Worker's plain routes. */

/** An RFC 7807 problem, the error shape the registry uses, for the other plain routes too. */
export function problem(
  status: number,
  title: string,
  detail?: string,
  headers: HeadersInit = {}
): Response {
  return Response.json(
    detail === undefined ? { status, title } : { detail, status, title },
    {
      headers: {
        "content-type": "application/problem+json",
        ...Object.fromEntries(new Headers(headers)),
      },
      status,
    }
  );
}

/** `401` with the challenge a client needs to retry with a key. */
export function unauthorized(detail: string): Response {
  return problem(401, "Unauthorized", detail, {
    "www-authenticate": 'Bearer realm="shelfkit"',
  });
}
