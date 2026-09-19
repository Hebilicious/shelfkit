/**
 * Design tokens. Values live in `cssforge.config.ts`; the generated CSS is
 * imported as a layer and the typed object is re-exported here so components
 * have one import for both.
 *
 * CSSForge is experimental with an unstable schema, which is affordable
 * because its output is generated and committed. See docs/PRD.md section 9.3.
 */
export { cssForge } from "../.cssforge/output.ts";

/** The cascade layer the generated stylesheet is imported into. */
export const LAYER = "cssforge";
