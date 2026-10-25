/// <reference types="@cloudflare/vitest-plugin/types" />
import "vitest";

declare module "vitest" {
  interface ProvidedContext {
    /** A fixture shelf with every item kind: path from its root to base64 contents. */
    readonly allKindsShelf: Record<string, string>;
    /** The workspace version in Cargo.toml, the CLI's. */
    readonly cargoVersion: string;
    /** ShelfKit's own shelf. */
    readonly ownShelf: Record<string, string>;
    /** `wrangler.jsonc`, as JSON. */
    readonly wranglerConfig: string;
    /** The registry conformance suite: `cases.json`, and each archive in base64 by its `file`. */
    readonly conformance: {
      readonly cases: string;
      readonly archives: Record<string, string>;
    };
  }
}
