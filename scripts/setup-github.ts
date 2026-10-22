/**
 * The parts of `setup.ts` that decide something, kept apart from the ones that run Wrangler, `gh`, or a browser, so
 * `setup-github.test.ts` can check them: how the owner's account is asked for, what a failed secret listing means, the
 * deploy command, the app's manifest, and the loopback page that hands the manifest to GitHub.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * `gh api` for the account signed in on github.com itself. Without `--hostname`, `gh` follows `GH_HOST`, and a GitHub
 * Enterprise account's numeric id would become the owner's: on github.com, that id is somebody else.
 */
export const OWNER_LOOKUP = ["api", "--hostname", "github.com", "user"];

/**
 * The deploy command. It never carries a secret: setup sets every secret afterwards with `wrangler secret put`, on
 * standard input, so none is ever written to a file, and the Worker refuses to authenticate anyone until they are set.
 */
export function deployCommand(): string[] {
  return ["deploy"];
}

/** What `wrangler secret list` said: the secret names, or that the Worker does not exist yet. */
export type SecretListing =
  | { readonly kind: "listed"; readonly names: ReadonlySet<string> }
  | { readonly kind: "no-worker" };

/** Terminal colour and style sequences, which Wrangler puts around its errors. */
// oxlint-disable-next-line eslint/no-control-regex -- the escape character is what this matches.
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/gu;

/**
 * Whether Wrangler's output says the Worker does not exist: `Worker "<name>" not found.` (Wrangler 4.134.0), or
 * Cloudflare's API error code for it, `[code: 10007]`, which other versions print.
 */
function workerMissing(output: string, worker: string): boolean {
  const plain = output.replaceAll(ANSI, "");
  return (
    plain.includes(`Worker "${worker}" not found.`) ||
    plain.includes("[code: 10007]")
  );
}

/**
 * Read `wrangler secret list --format json`. A Worker that does not exist has no secrets. Any other failure stops
 * setup: taking it for "no secrets" would replace the owner key, the session secret, and the owner's account, and
 * create a second GitHub App.
 */
export function readSecretListing(
  ran: {
    readonly status: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  worker: string
): SecretListing {
  if (ran.status !== 0) {
    if (workerMissing(`${ran.stdout}\n${ran.stderr}`, worker)) {
      return { kind: "no-worker" };
    }
    throw new Error(
      "could not list the Worker's secrets, so setup cannot tell which exist; it stops rather than replace them. Run `wrangler secret list` to see why."
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ran.stdout);
  } catch {
    throw new Error("`wrangler secret list --format json` printed no JSON");
  }
  if (!isSecretList(parsed)) {
    throw new Error("`wrangler secret list --format json` printed no list");
  }
  return {
    kind: "listed",
    names: new Set(parsed.map((secret) => secret.name)),
  };
}

// BOUNDARY: `wrangler secret list --format json` is unknown until this guard has checked each entry's name.
function isSecretList(
  value: unknown
): value is readonly { readonly name: string }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        typeof entry.name === "string"
    )
  );
}

// BOUNDARY: `server.address()` is a string for a pipe and null before listening; a TCP listener's is its address.
export function isAddressInfo(value: unknown): value is AddressInfo {
  return typeof value === "object" && value !== null && "port" in value;
}

/** The GraphQL operation that makes a one-time sign-in link for the owner, with the owner key. */
export const SIGN_IN_LINK = "mutation { createSignInLink { url expiresAt } }";

// BOUNDARY: the Worker's answer is unknown until this guard has found the link and its expiry.
function isSignInLinkAnswer(value: unknown): value is {
  readonly data: {
    readonly createSignInLink: {
      readonly url: string;
      readonly expiresAt: string;
    };
  };
} {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    return false;
  }
  const { data } = value;
  if (
    typeof data !== "object" ||
    data === null ||
    !("createSignInLink" in data)
  ) {
    return false;
  }
  const link = data.createSignInLink;
  return (
    typeof link === "object" &&
    link !== null &&
    "url" in link &&
    typeof link.url === "string" &&
    "expiresAt" in link &&
    typeof link.expiresAt === "string"
  );
}

/** The link in the Worker's answer to `SIGN_IN_LINK`, or why there is none. */
export function readSignInLink(text: string): {
  readonly url: string;
  readonly expiresAt: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "the deployment answered the sign-in link request with no JSON"
    );
  }
  if (!isSignInLinkAnswer(parsed)) {
    throw new Error(
      `the deployment made no sign-in link: ${text.slice(0, 200)}. Run \`shelfkit open\` once the deployment answers`
    );
  }
  return parsed.data.createSignInLink;
}

/**
 * What setup says about the owner's enrollment link. The link is a credential until used, so it is printed only when
 * it was not opened: with `--no-open`, or when no browser opener started.
 */
export function enrollmentMessage(link: {
  readonly url: string;
  readonly expiresAt: string;
  readonly noOpen: boolean;
  readonly opened: boolean;
}): string {
  const about = `it works once, until ${link.expiresAt}, and signs that browser in as the owner. Add a passkey there; to sign in elsewhere later, run \`shelfkit open\` or make a link on a signed-in device.`;
  if (link.opened) {
    return `    opened the owner's sign-in link in your browser; ${about}`;
  }
  const why = link.noOpen ? "--no-open" : "no browser opened";
  return `    ${why}: open this link yourself, and let nobody else see it; ${about}\n\n    ${link.url}\n`;
}

/** The URL GitHub sends a browser back to after signing in on a deployment at `origin`. */
export function callbackUrl(origin: string): string {
  return new URL("/auth/github/callback", origin).toString();
}

/**
 * The addresses a deployment answers on, from Wrangler's output file (`WRANGLER_OUTPUT_FILE_PATH`). A deploy event's
 * `targets` list every trigger Wrangler printed under "Deployed <name> triggers": the routes, but also the cron
 * schedule (`schedule: 0 * * * *`) and the queues (`Producer for shelfkit-jobs`). Only `https:` URLs with a host are
 * addresses; each is reduced to its origin, and duplicates go. Setup stops when none is left rather than register
 * anything else with GitHub.
 */
export function deploymentOrigins(outputFile: string): string[] {
  const origins = new Set<string>();
  for (const line of outputFile.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const event: unknown = JSON.parse(line);
    if (!isDeployEvent(event)) {
      continue;
    }
    for (const target of event.targets) {
      const origin = httpsOrigin(target.replaceAll(ANSI, "").trim());
      if (origin !== null) {
        origins.add(origin);
      }
    }
  }
  if (origins.size === 0) {
    throw new Error(
      "Wrangler reported no https address for the Worker; check `workers_dev` or the routes in wrangler.jsonc"
    );
  }
  return [...origins];
}

/** The origin of an `https:` URL with a host, or `null` for anything else. */
function httpsOrigin(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return url.protocol === "https:" && url.hostname !== "" ? url.origin : null;
}

// BOUNDARY: a line of Wrangler's output file is unknown until this guard has found a deploy event with its targets.
function isDeployEvent(
  value: unknown
): value is { readonly type: "deploy"; readonly targets: readonly string[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "deploy" &&
    "targets" in value &&
    Array.isArray(value.targets) &&
    value.targets.every((target: unknown) => typeof target === "string")
  );
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The GitHub App's manifest. It asks for no permissions and has no webhook. Its callbacks are every address the
 * deployment answers on (GitHub allows ten); a custom domain added later needs its callback added in the app's
 * settings.
 */
export function appManifest(deployments: readonly string[], page: string) {
  const [home = ""] = deployments;
  const host = new URL(home).hostname.replace(/\.workers\.dev$/u, "");
  return {
    callback_urls: deployments.slice(0, 10).map(callbackUrl),
    default_events: [],
    default_permissions: {},
    description: `Sign-in for the ShelfKit deployment at ${home}. It asks for no permissions: it only tells ShelfKit who signed in.`,
    hook_attributes: { active: false, url: home },
    name: `ShelfKit ${host}`.slice(0, 34),
    public: true,
    redirect_url: new URL("/created", page).toString(),
    request_oauth_on_install: false,
    url: home,
  };
}

/** What the loopback page needs to know. */
export interface LoopbackOptions {
  /** The page's own address, `http://127.0.0.1:<port>/`. */
  readonly page: () => string;
  /** The random value GitHub must send back, so only the app this run asked for is accepted. */
  readonly state: string;
  /** Every address the deployment answers on, the first being its home. */
  readonly deployments: readonly string[];
  /** Where the manifest goes: github.com's new-app page for an account or an organization. */
  readonly target: string;
  /** Called once, with GitHub's code, after the page saying so has been sent. */
  readonly created: (code: string) => void;
}

/**
 * The loopback page's request handler. It answers only requests addressed to `127.0.0.1:<port>` (another `Host` is a
 * page on another site reaching this port through DNS rebinding), serves the manifest page once, and accepts one
 * `/created` carrying this run's state.
 */
export function loopbackHandler(
  options: LoopbackOptions
): (incoming: IncomingMessage, outgoing: ServerResponse) => void {
  let served = false;
  let done = false;
  return (incoming, outgoing) => {
    const page = options.page();
    const own = new URL(page).host;
    const html = (status: number, body: string) => {
      outgoing.writeHead(status, {
        "cache-control": "no-store",
        connection: "close",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
      });
      outgoing.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ShelfKit setup</title></head><body>${body}</body></html>`
      );
    };
    if (incoming.headers.host !== own) {
      html(421, "<p>This page answers only on its own address.</p>");
      return;
    }
    const url = new URL(incoming.url ?? "/", page);
    if (url.pathname === "/created") {
      const code = url.searchParams.get("code") ?? "";
      if (
        done ||
        url.searchParams.get("state") !== options.state ||
        code === ""
      ) {
        html(
          400,
          "<p>This is not the GitHub App this setup asked for. Go back to the terminal.</p>"
        );
        return;
      }
      done = true;
      // Once the page is sent, hand the code over; that closes the server.
      outgoing.on("finish", () => {
        options.created(code);
      });
      html(
        200,
        "<p>The GitHub App is created. Go back to the terminal; you can close this tab.</p>"
      );
      return;
    }
    if (url.pathname !== "/") {
      html(404, "<p>Not found.</p>");
      return;
    }
    if (served) {
      html(
        410,
        "<p>The manifest was already sent to GitHub. Go back to the terminal, or run setup again.</p>"
      );
      return;
    }
    served = true;
    const manifest = appManifest(options.deployments, page);
    html(
      200,
      `<h1>Create ShelfKit's GitHub App</h1><p>This sends the app's manifest to GitHub. On the next page, click <strong>Create GitHub App</strong>. It asks for no permissions.</p><form method="post" action="${escapeHtml(`${options.target}?state=${options.state}`)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form>`
    );
  };
}
