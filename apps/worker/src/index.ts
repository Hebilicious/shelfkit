/**
 * The ShelfKit Worker.
 *
 * Its surfaces, deliberately separate:
 *   /apm/v1/*  the OpenAPM registry wire contract, a plain fetch handler (`registry.ts`)
 *   /mcp       stateless MCP tools (`mcp/`, issue #6)
 *   /graphql   everything the UI and CLI do, including key management (`graphql/`)
 *   /raw/*     a shelf's content-addressed files, for the browser's engine (`raw.ts`)
 *   /git/*     each shelf's Git repository, for `git clone`, `push`, and APM (`git.ts`)
 *   /auth/passkey/*  signing the browser in with a passkey, and adding one (`auth/passkeys.ts`)
 *   /auth/github/*   signing the browser in with GitHub, when enabled (`auth/github.ts`)
 *   /auth/cli/*      signing the CLI in through the browser: `shelfkit login` (`auth/cli.ts`)
 *   /install.sh, /install.ps1  install the `shelfkit` CLI of this deployment's version (`install-script.ts`)
 *   /health    liveness
 *   /*         the SPA, from the assets binding
 *
 * Every authenticated surface resolves its credential with `auth/`, so a revoked key fails on all of them at once.
 * `/mcp` is for programs, so it reads the `Authorization` header only, never the browser's session cookie.
 * Module scope does nothing but import: the engine and the GraphQL schema are built on first use, so the Worker's
 * startup stays inside the platform's limit (`moon run worker:startup-check`). See docs/PRD.md sections 7, 8, and 10.
 */
import { cliLoginRoute } from "./auth/cli.ts";
import { githubRoute } from "./auth/github.ts";
import { authenticateHeader } from "./auth/index.ts";
import { passkeyRoute } from "./auth/passkeys.ts";
import { gitRoute } from "./git.ts";
import { graphqlRoute } from "./graphql/route.ts";
import { unauthorized } from "./http.ts";
import { installScriptRoute } from "./install-script.ts";
import { consume, scheduled } from "./jobs/consumer.ts";
import { handleMcp } from "./mcp/index.ts";
import { rawRoute } from "./raw.ts";
import { registryRoute } from "./registry.ts";

export { AccountIndex } from "./auth/accounts.ts";
export { CliLoginIndex } from "./auth/cli-logins.ts";
export { ShelfIndex } from "./shelf-index.ts";

export default {
  async fetch(request, env, context): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") {
      return Response.json({ ok: true, version: env.SHELFKIT_VERSION });
    }
    if (pathname === "/graphql") {
      return await graphqlRoute(request, env, context);
    }
    if (pathname === "/apm" || pathname.startsWith("/apm/")) {
      return await registryRoute(request, env);
    }
    if (pathname.startsWith("/raw/")) {
      return await rawRoute(request, env);
    }
    if (pathname.startsWith("/git/")) {
      return await gitRoute(request, env);
    }
    if (pathname.startsWith("/auth/github/")) {
      return await githubRoute(request, env);
    }
    if (pathname.startsWith("/auth/cli/")) {
      return await cliLoginRoute(request, env);
    }
    if (pathname.startsWith("/auth/passkey/")) {
      return await passkeyRoute(request, env);
    }
    const script = installScriptRoute(request, env.SHELFKIT_VERSION);
    if (script !== null) {
      return script;
    }
    if (pathname === "/mcp") {
      const session = await authenticateHeader(request, env);
      if (session.kind === "invalid") {
        return unauthorized(
          "the key is not valid: it is malformed, unknown, or revoked"
        );
      }
      return await handleMcp(request, env, context, session);
    }
    return await env.ASSETS.fetch(request);
  },

  async queue(batch, env): Promise<void> {
    await consume(batch, env);
  },

  async scheduled(_controller, env): Promise<void> {
    await scheduled(env);
  },
} satisfies ExportedHandler<Env>;
