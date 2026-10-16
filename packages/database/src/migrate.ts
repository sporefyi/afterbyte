#!/usr/bin/env node
/**
 * Migration runner: applies drizzle/ migrations to DATABASE_URL.
 * Usage: pnpm migrate
 *
 * Never destructive on production: migrations in this repo are
 * expand/backfill/contract only (see ADR-0003); CI blocks destructive
 * migrations against production targets.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./db.js";

/**
 * Apply pending migrations.
 *
 * The migrations folder defaults to this package's own drizzle/ directory,
 * resolved relative to this file — NOT the process working directory — so it
 * works from any CWD, including inside a deployed container where the
 * package lives under node_modules/@afterbyte/database.
 */
export async function runMigrations(migrationsFolder?: string): Promise<void> {
  const folder =
    migrationsFolder ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
  const { pool, db } = createDb();
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  await runMigrations();
  console.log("migrations applied");
}

// Only run the CLI when executed directly; importing this module (e.g. the
// API importing runMigrations) must not trigger a migration as a side effect.
const invokedAsScript =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main().catch((err) => {
    console.error("migration failed:", err);
    process.exit(1);
  });
}
