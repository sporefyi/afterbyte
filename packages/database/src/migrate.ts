#!/usr/bin/env node
/**
 * Migration runner: applies drizzle/ migrations to DATABASE_URL.
 * Usage: pnpm migrate
 *
 * Never destructive on production: migrations in this repo are
 * expand/backfill/contract only (see ADR-0003); CI blocks destructive
 * migrations against production targets.
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./db.js";

async function main(): Promise<void> {
  const { pool, db } = createDb();
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
