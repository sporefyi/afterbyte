import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config. Migrations are generated with `pnpm db:generate`
 * (works offline — no live database required) and applied with `pnpm migrate`.
 *
 * The initial migration (drizzle/0000_*.sql) has `CREATE EXTENSION IF NOT
 * EXISTS pg_trgm;` prepended by hand because drizzle-kit does not emit
 * extension DDL. This is documented and intentional.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  verbose: true,
  strict: true,
});
