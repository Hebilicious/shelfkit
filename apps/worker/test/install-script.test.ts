/**
 * `/install.sh` and `/install.ps1` install the CLI of the deployment's own version, from that version's GitHub
 * release, so the CLI a deployment hands out always speaks its API.
 */
import { env, exports } from "cloudflare:workers";
import { describe, expect, inject, it } from "vitest";

const ORIGIN = "https://shelf.example.dev";

describe("the CLI's install scripts", () => {
  it("are of the CLI's version: Cargo.toml's workspace version is the Worker's SHELFKIT_VERSION", () => {
    expect(inject("cargoVersion")).not.toBe("");
    expect(env.SHELFKIT_VERSION).toBe(inject("cargoVersion"));
  });

  it("download that version's release, check it, and name this deployment", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/install.sh`);
    expect(response.status).toBe(200);
    const script = await response.text();
    expect(script.startsWith("#!/bin/sh\n")).toBeTruthy();
    for (const part of [
      `version="${env.SHELFKIT_VERSION}"`,
      "https://github.com/Hebilicious/shelfkit/releases/download/v$version",
      "SHA256SUMS",
      `irm ${ORIGIN}/install.ps1 | iex`,
    ]) {
      expect(script).toContain(part);
    }
  });

  it("has a PowerShell twin for Windows", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/install.ps1`);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain(
      `$version = "${env.SHELFKIT_VERSION}"`
    );
  });
});
