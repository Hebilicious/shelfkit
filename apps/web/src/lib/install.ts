/**
 * The words and commands that install a profile into a repository, as a prompt to hand an agent or commands to paste
 * into a terminal, two ways:
 *
 * - With the ShelfKit CLI (the default): `shelfkit install <shelf>/<profile> --url <deployment>` adds the profile to
 *   the repository's apm.yml and runs APM, handing it the key `shelfkit login` keeps for a private shelf. `shelfkit
 *   login` signs the CLI in through the browser, so nobody copies a key; CI, which has no browser, pipes it a key.
 * - With APM alone: the repository's apm.yml names the shelf's registry and the profile's newest version, and `apm
 *   install` does the rest. Verified against APM 0.33: a named registry, and a dependency that routes to it pinned to
 *   an exact version. A range cannot follow a profile, since APM ranks every generated `0.0.0+…` version the same and
 *   picks the oldest among them (`crates/compiler/src/package.rs`).
 *
 * Either way the profile comes from the shelf's registry, which `shelfkit push` publishes it to, and a profile's
 * instructions, tech stacks, and library notes go into one section of AGENTS.md, which `apm compile` writes between
 * two marker lines and CLAUDE.md imports (`crates/compiler/src/cli/install.rs` does the same steps).
 */

/** The pinned APM, run through uv so nothing has to be installed first. */
export const APM = "uvx --from apm-cli==0.33.0 apm";

export interface InstallTarget {
  /** The profile's title, for the prompt. */
  readonly title: string;
  readonly profile: string;
  /** The registry package: `<namespace>/<profile>`. */
  readonly coordinate: string;
  /** The deployment, `https://<host>`: where the CLI's install script and the shelf are. */
  readonly origin: string;
  /** The shelf's registry, `https://<host>/apm`. */
  readonly registryUrl: string;
  /** The agents the profile sets up, as APM's target slugs. */
  readonly targets: readonly string[];
  /** A private shelf's registry needs a key with read scope. */
  readonly isPrivate: boolean;
  /** The profile has instructions, tech stacks, or library notes, which go into AGENTS.md. */
  readonly instructions: boolean;
  /** The profile has docs, which install into `.agents/skills/` and which the instructions link to. */
  readonly docs: boolean;
  /** The newest published version, which apm.yml pins; `null` before the first publish. */
  readonly version: string | null;
}

/** The lines of AGENTS.md between which `apm compile` writes the instructions. */
export const MARKERS = ["<!-- apm:start -->", "<!-- apm:end -->"] as const;

/** `apm compile` for AGENTS.md alone: Codex's output is that file and nothing else (see install.rs). */
const COMPILE = "compile --target codex";

/** The registry's name in apm.yml: the namespace, which is also what APM names the token variable after. */
export function registryName(target: InstallTarget): string {
  return target.coordinate.split("/")[0] ?? "shelf";
}

/** The environment variable APM reads a registry's key from: `APM_REGISTRY_TOKEN_<NAME>`. */
export function tokenVariable(target: InstallTarget): string {
  return `APM_REGISTRY_TOKEN_${registryName(target).toUpperCase().replaceAll(/[-.]/gu, "_")}`;
}

/** The one command that installs the profile, once the CLI is there. */
export function cliCommand(target: InstallTarget): string {
  return `shelfkit install ${target.coordinate} --url ${target.origin}`;
}

/** Commands to paste in the repository's folder: install the CLI, sign it in for a private shelf, install. */
export function cliTerminalSteps(target: InstallTarget): string {
  const lines = [
    "# Once per computer: the ShelfKit CLI, into ~/.local/bin, which this shell then finds it in.",
    `# On Windows, in PowerShell: irm ${target.origin}/install.ps1 | iex`,
    `curl -fsSL ${target.origin}/install.sh | sh`,
    'export PATH="$HOME/.local/bin:$PATH"',
    "",
  ];
  if (target.isPrivate) {
    lines.push(
      "# Once per computer: sign the CLI in to read this private shelf. It opens your browser:",
      "# approve there if the page shows the code this terminal shows. The key goes to the OS keychain.",
      "# (In CI, with no browser, pipe it a key from Settings → Keys instead.)",
      `shelfkit login ${target.origin}`,
      ""
    );
  }
  lines.push(
    "# In the repository: adds the profile to apm.yml, and APM installs it. It also turns on",
    "# APM's registry support in APM's settings for this computer.",
    cliCommand(target)
  );
  return lines.join("\n");
}

const COMMIT_STEP =
  "Tell me which files were written. Commit them with apm.yml, apm.lock.yaml, and .gitignore (where APM keeps apm_modules/ out of git), but do not edit the installed files: the next install writes them again from the shelf.";

/** A prompt that has an agent install the CLI if it is missing, then the profile with it. */
export function cliAgentPrompt(target: InstallTarget): string {
  const lines = [
    `Install the ShelfKit profile "${target.title}" (${target.coordinate}) into this repository with the ShelfKit CLI.`,
    "",
    `1. If \`shelfkit --version\` fails, install the CLI: \`curl -fsSL ${target.origin}/install.sh | sh\` (on Windows, in PowerShell: \`irm ${target.origin}/install.ps1 | iex\`). It goes into ~/.local/bin; when that is not on PATH, run it as \`~/.local/bin/shelfkit\`.`,
    `2. At the repository root, run \`${cliCommand(target)}\` (as \`~/.local/bin/shelfkit\` if step 1 put it off PATH). It adds the profile to apm.yml, keeping what is already there, and runs APM, which writes the files each agent reads. It also turns on APM's registry support in APM's settings for this computer${target.isPrivate ? ", and records the shelf's registry there" : ""}.`,
  ];
  if (target.isPrivate) {
    lines.push(
      `   The shelf is private. If shelfkit says it has no key for ${target.origin}, stop and ask me to run \`shelfkit login ${target.origin}\` in my own terminal, where it signs the CLI in through my browser, then run step 2 again. Do not run it yourself, do not ask me for a key, and never put a key in a file or a command.`
    );
  }
  lines.push(`3. ${COMMIT_STEP}`);
  return lines.join("\n");
}

/**
 * What a repository's apm.yml needs, as YAML: the registry, the dependency on the profile, and, for a profile with
 * instructions, the `compilation` settings that have `apm compile` write them into AGENTS.md between the markers.
 */
export function manifestEntries(target: InstallTarget): string {
  const name = registryName(target);
  const lines = [
    "registries:",
    `  ${name}:`,
    `    url: ${target.registryUrl}`,
    "dependencies:",
    "  apm:",
    `    - registry: ${name}`,
    `      id: ${target.coordinate}`,
    `      version: "${target.version ?? ">=0.0.0"}"`,
  ];
  if (target.instructions) {
    lines.push(
      "compilation:",
      "  strategy: single-file",
      "  agents_md:",
      "    mode: managed_section",
      "  resolve_links: false"
    );
  }
  return lines.join("\n");
}

/**
 * The agents a new apm.yml sets up: the profile's, or, when it names none, the four most repositories use. APM 0.33
 * refuses to install into a repository with neither `targets` nor a harness's files (`shelfkit install` checks for
 * those; pasted steps cannot).
 */
function targetList(target: InstallTarget): string {
  const targets =
    target.targets.length > 0
      ? [...target.targets]
      : ["claude", "codex", "copilot", "cursor"];
  // Docs are linked at their copy in .agents/skills/, which every one of these targets but Claude Code installs into.
  if (
    target.docs &&
    targets.every((slug) => !SKILLS_FOLDER_TARGETS.has(slug))
  ) {
    targets.push("agent-skills");
  }
  return targets.join(", ");
}

/** The targets that install skills into `.agents/skills/` (`crates/compiler/src/docs.rs`, `DEPLOYING_TARGETS`). */
const SKILLS_FOLDER_TARGETS: ReadonlySet<string> = new Set([
  "agent-skills",
  "all",
  "antigravity",
  "codex",
  "copilot",
  "cursor",
  "gemini",
  "opencode",
  "windsurf",
]);

/** A prompt that has an agent install the profile with APM alone. */
export function apmAgentPrompt(target: InstallTarget): string {
  const lines = [
    `Install the ShelfKit profile "${target.title}" (${target.coordinate}) into this repository with APM.`,
    "",
    `1. Turn on APM's registry support once on this machine: \`${APM} experimental enable registries\`. If \`apm\` is installed, use \`apm\` in place of \`${APM}\` everywhere.`,
    `2. Edit apm.yml at the repository root. If there is none, create it with \`name:\` set to the repository's directory name, \`version: 0.0.0\`, and \`targets: [${targetList(target)}]\`. Keep everything already in it, and add these entries, merging them into what it has (its \`registries:\` map, its \`dependencies.apm:\` list${target.instructions ? ", its `compilation:` settings" : ""}):`,
    "",
    "```yaml",
    manifestEntries(target),
    "```",
    "",
  ];
  const steps: string[] = [];
  if (target.isPrivate) {
    steps.push(
      `The shelf is private. APM sends a key only to a registry its user config names, so run \`${APM} config set registry.${registryName(target)}.url ${target.registryUrl}\`. Then ask me for a ShelfKit key with read scope (the shelf's owner makes one in Settings → Keys), and run the install with it in \`${tokenVariable(target)}\`. Never write the key into a file.`
    );
  }
  steps.push(`Run \`${APM} install\`.`);
  if (target.instructions) {
    steps.push(
      `Put the instructions into AGENTS.md, which every agent reads. AGENTS.md needs the two lines \`${MARKERS[0]}\` and \`${MARKERS[1]}\`: add them at its end if they are missing, or create it with just them, and leave everything else in it as it is. CLAUDE.md needs a line \`@AGENTS.md\`, so Claude Code reads AGENTS.md too: add it, or create CLAUDE.md with just it. Then run \`${APM} ${COMPILE}\`, which writes the instructions between the two lines.`
    );
  }
  steps.push(COMMIT_STEP);
  for (const [at, step] of steps.entries()) {
    lines.push(`${at + 3}. ${step}`);
  }
  return lines.join("\n");
}

/** Commands to paste in the repository's folder that install the profile with APM alone, for a repository with no apm.yml yet. */
export function apmTerminalSteps(target: InstallTarget): string {
  const lines = [
    "# Once per computer: APM's registry support is behind a flag.",
    `${APM} experimental enable registries`,
    "",
    "# In the repository: an apm.yml that installs the profile.",
    "cat > apm.yml <<EOF",
    'name: $(basename "$PWD")',
    "version: 0.0.0",
    `targets: [${targetList(target)}]`,
    manifestEntries(target),
    "EOF",
    "",
  ];
  if (target.isPrivate) {
    lines.push(
      "# The shelf is private. APM sends a key only to a registry its user config names,",
      "# and reads the key (one with read scope, from the shelf's Settings → Keys) from the environment.",
      `${APM} config set registry.${registryName(target)}.url ${target.registryUrl}`,
      `read -rs ${tokenVariable(target)} && export ${tokenVariable(target)}`,
      ""
    );
  }
  lines.push(`${APM} install`);
  if (target.instructions) {
    lines.push(
      "",
      "# The instructions go into AGENTS.md, which every agent reads, between two lines APM writes within;",
      "# CLAUDE.md brings AGENTS.md in for Claude Code. What either file already says is kept.",
      `grep -qF '${MARKERS[0]}' AGENTS.md 2>/dev/null || printf '\\n%s\\n%s\\n' '${MARKERS[0]}' '${MARKERS[1]}' >> AGENTS.md`,
      "grep -qx '@AGENTS.md' CLAUDE.md 2>/dev/null || printf '\\n@AGENTS.md\\n' >> CLAUDE.md",
      `${APM} ${COMPILE}`
    );
  }
  lines.push(
    "",
    "# Later, to move to a newer version: set `version:` in apm.yml to the one this page shows, then",
    `#   ${APM} update --yes ${target.coordinate}${target.instructions ? ` && ${APM} ${COMPILE}` : ""}`,
    "# (apm install alone keeps the build apm.lock.yaml holds)."
  );
  return lines.join("\n");
}
