import { defineConfig } from "drizzle-kit";

/** `moon run worker:db-generate` writes the shelf object's migrations here, and `drizzle/migrations.js` bundles them. */
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  out: "./drizzle",
  schema: "./src/db/schema.ts",
});
