import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "./schema.js";

/** Database handle type shared with API and worker lanes. */
export type Db = NodePgDatabase<typeof schema>;

let singleton: { pool: Pool; db: Db } | null = null;

/**
 * Create a Postgres connection pool + Drizzle client.
 *
 * Reads `DATABASE_URL` when no connection string is given. The pool is
 * deliberately small by default (workers size their own pools); pass
 * explicit options to override.
 */
export function createDb(
  connectionString: string = mustGetDatabaseUrl(),
  poolOptions: { max?: number } = {},
): { pool: Pool; db: Db } {
  const pool = new Pool({
    connectionString,
    max: poolOptions.max ?? 10,
  });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

/**
 * Process-wide singleton used by CLI entrypoints (migrate/seed) and tests.
 * Long-lived services should call createDb() once and manage the pool
 * lifecycle themselves.
 */
export function getDb(): { pool: Pool; db: Db } {
  if (!singleton) {
    singleton = createDb();
  }
  return singleton;
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.pool.end();
    singleton = null;
  }
}

function mustGetDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env or export DATABASE_URL " +
        "before creating a database client.",
    );
  }
  return url;
}

export { schema };
