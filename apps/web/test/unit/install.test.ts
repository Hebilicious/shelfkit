import { describe, expect, it } from "vitest";

import {
  agentPrompt,
  cliSteps,
  manifestEntries,
  terminalSteps,
  tokenVariable,
} from "../../src/lib/install.ts";
import type { InstallTarget } from "../../src/lib/install.ts";

const target: InstallTarget = {
  coordinate: "hebilicious/default",
  isPrivate: false,
  profile: "default",
  registryUrl: "https://shelf.example.dev/apm",
  targets: ["claude", "codex"],
  title: "ShelfKit development",
};

describe("installing a profile", () => {
  it("declares a named registry and a dependency routed to it, following the newest version", () => {
    expect(manifestEntries(target)).toBe(
      [
        "registries:",
        "  hebilicious:",
        "    url: https://shelf.example.dev/apm",
        "dependencies:",
        "  apm:",
        "    - registry: hebilicious",
        "      id: hebilicious/default",
        '      version: ">=0.0.0"',
      ].join("\n")
    );
  });

  it("writes an apm.yml named after the repository's folder and runs APM", () => {
    const steps = terminalSteps(target);
    expect(steps).toContain("experimental enable registries");
    expect(steps).toContain('name: $(basename "$PWD")');
    expect(steps).toContain("targets: [claude, codex]");
    expect(steps.trimEnd().endsWith("apm install")).toBeTruthy();
    expect(steps).not.toContain("APM_REGISTRY_TOKEN");
  });

  it("asks for a key only for a private shelf, and keeps it out of files", () => {
    const secret = { ...target, isPrivate: true };
    expect(tokenVariable(secret)).toBe("APM_REGISTRY_TOKEN_HEBILICIOUS");
    expect(agentPrompt(secret)).toContain("APM_REGISTRY_TOKEN_HEBILICIOUS");
    expect(agentPrompt(secret)).toContain("Never write the key into a file");
    expect(terminalSteps(secret)).toContain(
      "read -rs APM_REGISTRY_TOKEN_HEBILICIOUS"
    );
    expect(agentPrompt(target)).not.toContain("APM_REGISTRY_TOKEN");
  });

  it("tells the agent to keep what apm.yml already holds", () => {
    expect(agentPrompt(target)).toContain("Keep everything already in it");
    expect(agentPrompt(target)).toContain(
      '"ShelfKit development" (hebilicious/default)'
    );
  });

  it("compiles with the CLI from a clone of the shelf, then installs", () => {
    expect(cliSteps(target, "../app")).toContain(
      "shelfkit compile default --repo ../app"
    );
    expect(cliSteps(target, "../app")).toContain(
      "shelfkit install --repo ../app"
    );
  });
});
