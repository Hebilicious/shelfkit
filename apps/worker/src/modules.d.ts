/**
 * Module types wrangler's bundler provides: a `.wasm` import is a compiled module. (`wrangler types` declares `.sql`
 * imports, which the Text rule in wrangler.jsonc makes.)
 */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

/** Drizzle's bundle of the generated migrations (`drizzle/migrations.js`), keyed by migration folder. */
declare module "*/drizzle/migrations.js" {
  const bundle: { readonly migrations: Record<string, string> };
  export default bundle;
}
