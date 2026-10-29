/**
 * Every Worker test runs against a deployment with Artifacts: `shelfRepository` answers with the real Artifacts
 * adapter over the stand-in binding (`fake-artifacts.ts`), since Wrangler never simulates Artifacts. A test that sets
 * `repositories.artifacts` to false sees a deployment without the binding, which keeps its repositories in R2 as local
 * mode does.
 */
import { vi } from "vitest";

import type * as RepositoryModule from "../src/repository/index.ts";

// oxlint-disable-next-line anti-slop/no-module-mocking -- a Durable Object takes no injected dependency and Miniflare cannot run Artifacts, so the binding the real adapter reads is the one thing swapped.
vi.mock("../src/repository/index.ts", async (original) => {
  const actual = await original<typeof RepositoryModule>();
  const { ArtifactsRepository } =
    await import("../src/repository/artifacts.ts");
  const { fakeArtifacts, repositories } = await import("./fake-artifacts.ts");
  return {
    ...actual,
    shelfRepository: (env: Env) =>
      repositories.artifacts
        ? new ArtifactsRepository(fakeArtifacts, fakeArtifacts.fetch)
        : actual.shelfRepository(env),
  };
});
