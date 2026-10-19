/** Module types wrangler's bundler provides: a `.wasm` import is a compiled module, a `.sql` import is its text. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "*.sql" {
  const text: string;
  export default text;
}

/** Drizzle's bundle of the generated migrations (`drizzle/migrations.js`), keyed by migration folder. */
declare module "*/drizzle/migrations.js" {
  const bundle: { readonly migrations: Record<string, string> };
  export default bundle;
}
