/**
 * The words and commands that install a profile into a repository: a prompt to hand an agent, the commands to paste
 * into a terminal, and the ShelfKit CLI's. Each installs through the shelf's registry with stock APM, which the
 * profile was published to by `shelfkit push`: the repository's apm.yml names the registry and the profile, and
 * `apm install` does the rest. Verified against APM 0.33: a named registry, a dependency that routes to it, and a
 * `>=0.0.0` range, which follows the newest version published.
 */

/** The pinned APM, run through uv so nothing has to be installed first. */
export const APM = "uvx --from apm-cli==0.33.0 apm";

export interface InstallTarget {
  /** The profile's title, for the prompt. */
  readonly title: string;
  readonly profile: string;
  /** The registry package: `<namespace>/<profile>`. */
  readonly coordinate: string;
  /** The shelf's registry, `https://<host>/apm`. */
  readonly registryUrl: string;
  /** The agents the profile sets up, as APM's target slugs. */
  readonly targets: readonly string[];
  /** A private shelf's registry needs a key with read scope. */
  readonly isPrivate: boolean;
}

/** The registry's name in apm.yml: the namespace, which is also what APM names the token variable after. */
export function registryName(target: InstallTarget): string {
  return target.coordinate.split("/")[0] ?? "shelf";
}

/** The environment variable APM reads a registry's key from: `APM_REGISTRY_TOKEN_<NAME>`. */
export function tokenVariable(target: InstallTarget): string {
  return `APM_REGISTRY_TOKEN_${registryName(target).toUpperCase().replaceAll(/[-.]/gu, "_")}`;
}

/** The two declarations a repository's apm.yml needs, as YAML. */
export function manifestEntries(target: InstallTarget): string {
  const name = registryName(target);
  return [
    "registries:",
    `  ${name}:`,
    `    url: ${target.registryUrl}`,
    "dependencies:",
    "  apm:",
    `    - registry: ${name}`,
    `      id: ${target.coordinate}`,
    '      version: ">=0.0.0"',
  ].join("\n");
}

function targetList(target: InstallTarget): string {
  return target.targets.length === 0
    ? "claude, codex, copilot, cursor"
    : target.targets.join(", ");
}

/** A prompt that has an agent install the profile into the repository it works in. */
export function agentPrompt(target: InstallTarget): string {
  const lines = [
    `Install the ShelfKit profile "${target.title}" (${target.coordinate}) into this repository with APM.`,
    "",
    `1. Turn on APM's registry support once on this machine: \`${APM} experimental enable registries\`. If \`apm\` is installed, use \`apm\` in place of \`${APM}\` everywhere.`,
    `2. Edit apm.yml at the repository root. If there is none, create it with \`name:\` set to the repository's directory name, \`version: 0.0.0\`, and \`targets: [${targetList(target)}]\`. Keep everything already in it, and add these two entries, merging them into an existing \`registries:\` map and \`dependencies.apm:\` list:`,
    "",
    "```yaml",
    manifestEntries(target),
    "```",
    "",
  ];
  if (target.isPrivate) {
    lines.push(
      `3. The shelf is private. Ask me for a ShelfKit key with read scope (the shelf's owner makes one in Settings), and run the install with it in \`${tokenVariable(target)}\`. Never write the key into a file.`,
      `4. Run \`${APM} install\`.`,
      "5. Tell me which files APM wrote. Commit apm.yml, apm.lock.yaml, and those files, but do not edit the installed files: they are regenerated from the shelf on the next install."
    );
  } else {
    lines.push(
      `3. Run \`${APM} install\`.`,
      "4. Tell me which files APM wrote. Commit apm.yml, apm.lock.yaml, and those files, but do not edit the installed files: they are regenerated from the shelf on the next install."
    );
  }
  return lines.join("\n");
}

/** Commands to paste in the repository's directory, for a repository with no apm.yml yet. */
export function terminalSteps(target: InstallTarget): string {
  const lines = [
    "# Once per machine: APM's registry support is behind a flag.",
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
      "# The shelf is private: a key with read scope, from the shelf's Settings.",
      `read -rs ${tokenVariable(target)} && export ${tokenVariable(target)}`,
      ""
    );
  }
  lines.push(`${APM} install`);
  return lines.join("\n");
}

/** The ShelfKit CLI's way, from a clone of the shelf's own repository: compile, then let APM install. */
export function cliSteps(
  target: InstallTarget,
  repository = "path/to/your/repo"
): string {
  return [
    "# In a clone of the shelf's repository. Writes apm.yml and copies the items",
    "# written on the shelf into vendor/ in your repository; runs nothing.",
    `shelfkit compile ${target.profile} --repo ${repository}`,
    "",
    "# Runs apm install there, through uvx when apm is not installed.",
    `shelfkit install --repo ${repository}`,
  ].join("\n");
}
