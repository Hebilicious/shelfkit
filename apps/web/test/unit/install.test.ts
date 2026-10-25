import { describe, expect, it } from "vitest";

import {
  apmAgentPrompt,
  apmTerminalSteps,
  cliAgentPrompt,
  cliCommand,
  cliTerminalSteps,
  manifestEntries,
  tokenVariable,
} from "../../src/lib/install.ts";
import type { InstallTarget } from "../../src/lib/install.ts";

const target: InstallTarget = {
  coordinate: "hebilicious/default",
  instructions: false,
  isPrivate: false,
  origin: "https://shelf.example.dev",
  profile: "default",
  registryUrl: "https://shelf.example.dev/apm",
  targets: ["claude", "codex"],
  title: "ShelfKit development",
  version: "0.0.0+sha256.abc.format3",
};
const secret: InstallTarget = { ...target, isPrivate: true };

describe("installing a profile with the ShelfKit CLI", () => {
  it("is one command naming the profile and the deployment", () => {
    expect(cliCommand(target)).toBe(
      "shelfkit install hebilicious/default --url https://shelf.example.dev"
    );
  });

  it("installs the CLI from this deployment, then the profile", () => {
    const steps = cliTerminalSteps(target);
    expect(steps).toContain(
      "curl -fsSL https://shelf.example.dev/install.sh | sh"
    );
    expect(steps.trimEnd().endsWith(cliCommand(target))).toBeTruthy();
    expect(steps).not.toContain("shelfkit login");
  });

  it("signs the CLI in once for a private shelf, before installing", () => {
    const steps = cliTerminalSteps(secret);
    const login = steps.indexOf("shelfkit login https://shelf.example.dev");
    expect(login).toBeGreaterThan(steps.indexOf("install.sh"));
    expect(login).toBeLessThan(steps.indexOf(cliCommand(secret)));
    expect(steps).toContain("approve there if the page shows the code");
  });

  it("has an agent install the CLI only when it is missing", () => {
    const prompt = cliAgentPrompt(target);
    expect(prompt).toContain("If `shelfkit --version` fails");
    expect(prompt).toContain("https://shelf.example.dev/install.ps1");
    expect(prompt).toContain(cliCommand(target));
    expect(prompt).not.toContain("shelfkit login");
  });

  it("has an agent ask for a login on a private shelf, never for the key", () => {
    const asked = cliAgentPrompt(secret);
    expect(asked).toContain(
      "ask me to run `shelfkit login https://shelf.example.dev` in my own terminal"
    );
    expect(asked).toContain("do not ask me for a key");
    expect(asked).toContain("Do not run it yourself");
  });
});

describe("installing a profile with APM alone", () => {
  it("declares a named registry and a dependency routed to it, pinned to the newest version", () => {
    expect(manifestEntries(target)).toBe(
      [
        "registries:",
        "  hebilicious:",
        "    url: https://shelf.example.dev/apm",
        "dependencies:",
        "  apm:",
        "    - registry: hebilicious",
        "      id: hebilicious/default",
        '      version: "0.0.0+sha256.abc.format3"',
      ].join("\n")
    );
  });

  it("puts a profile's instructions into AGENTS.md between the markers, and has CLAUDE.md import it", () => {
    const withRules = { ...target, instructions: true };
    expect(manifestEntries(withRules)).toContain(
      "compilation:\n  strategy: single-file\n  agents_md:\n    mode: managed_section"
    );
    const steps = apmTerminalSteps(withRules);
    expect(steps).toContain("<!-- apm:start -->");
    expect(steps).toContain("@AGENTS.md");
    expect(steps).toContain(
      "\nuvx --from apm-cli==0.33.0 apm compile --target codex\n"
    );
  });

  it("says how to move to a newer version later, which apm install alone does not", () => {
    expect(apmTerminalSteps(target)).toContain(
      "apm update --yes hebilicious/default"
    );
  });

  it("compiles only a profile that has instructions", () => {
    expect(apmAgentPrompt({ ...target, instructions: true })).toContain(
      "apm compile --target codex"
    );
    expect(apmTerminalSteps(target)).not.toContain("compile");
  });

  it("writes an apm.yml named after the repository's folder and runs APM", () => {
    const steps = apmTerminalSteps(target);
    expect(steps).toContain("experimental enable registries");
    expect(steps).toContain('name: $(basename "$PWD")');
    expect(steps).toContain("targets: [claude, codex]");
    expect(steps).toContain("apm install");
    expect(steps).not.toContain("APM_REGISTRY_TOKEN");
  });

  it("asks for a key only for a private shelf, and keeps it out of files", () => {
    expect(tokenVariable(secret)).toBe("APM_REGISTRY_TOKEN_HEBILICIOUS");
    expect(apmAgentPrompt(secret)).toContain("APM_REGISTRY_TOKEN_HEBILICIOUS");
    expect(apmAgentPrompt(secret)).toContain("Never write the key into a file");
    expect(apmTerminalSteps(secret)).toContain(
      "read -rs APM_REGISTRY_TOKEN_HEBILICIOUS"
    );
    expect(apmAgentPrompt(target)).not.toContain("APM_REGISTRY_TOKEN");
  });

  it("tells the agent to keep what apm.yml already holds", () => {
    expect(apmAgentPrompt(target)).toContain("Keep everything already in it");
    expect(apmAgentPrompt(target)).toContain(
      '"ShelfKit development" (hebilicious/default)'
    );
  });
});
