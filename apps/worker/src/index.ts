/**
 * The ShelfKit Worker.
 *
 * Three surfaces, deliberately separate:
 *   /apm/*     the registry wire contract, a plain fetch handler
 *   /mcp       stateless MCP tools
 *   /graphql   everything the UI and CLI do, including key management
 *
 * See docs/PRD.md sections 4, 7, 8, and 10.
 */
export { ShelfIndex } from "./shelf-index.ts";

export default {
  fetch(request: Request, env: Env): Response {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: env.SHELFKIT_VERSION });
    }

    return new Response("not implemented", { status: 501 });
  },
} satisfies ExportedHandler<Env>;
