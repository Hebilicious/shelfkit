/**
 * The SPA is served with a Content-Security-Policy that allows only its own scripts, styles and API, plus WebAssembly.
 * A shelf's raw objects are served as opaque bytes that a browser must not sniff into something it renders.
 */
import {
  BASE_URL,
  FIXTURES,
  OWNER_KEY,
  expect,
  seedShelf,
  test,
} from "./support.ts";

const REQUIRED = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "img-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
];

test("the SPA's pages and assets carry the Content-Security-Policy", async ({
  request,
}) => {
  for (const path of ["/", "/shelves/any/prompts", "/share/shs_any_x"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one page at a time; each answer is checked on its own.
    const response = await request.get(`${BASE_URL}${path}`);
    expect(response.status()).toBe(200);
    const policy = response.headers()["content-security-policy"] ?? "";
    for (const directive of REQUIRED) {
      expect(policy, path).toContain(directive);
    }
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  }
});

test("a shelf's raw objects are served as bytes a browser must not sniff", async ({
  request,
}) => {
  const shelf = "headers-e2e";
  seedShelf(FIXTURES.allKinds, shelf);
  const authorization = `Bearer ${OWNER_KEY}`;
  const listed = await request.post(`${BASE_URL}/graphql`, {
    data: {
      query:
        "query ($shelf: ID!) { shelf(id: $shelf) { files { path sha256 } } }",
      variables: { shelf },
    },
    headers: { authorization },
  });
  const body = await listed.text();
  const sha256 =
    /"sha256":"(?<digest>[0-9a-f]{64})"/u.exec(body)?.groups?.digest ?? "";
  expect(sha256).toHaveLength(64);
  const object = await request.get(
    `${BASE_URL}/raw/${shelf}/objects/${sha256}`,
    { headers: { authorization } }
  );
  expect(object.status()).toBe(200);
  expect(object.headers()["content-type"]).toBe("application/octet-stream");
  expect(object.headers()["x-content-type-options"]).toBe("nosniff");
});
