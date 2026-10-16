/**
 * API server bootstrap. Validates config on startup: core missing
 * credentials fail fast with a clear error naming the variable;
 * optional missing providers disable capabilities (reported by /config).
 */
import { loadConfig, capabilitiesOf, ConfigError } from './config.js';
import { buildApp, buildConfigPayload, defaultDependencies } from './app.js';
import type { ReadStore } from './services/store.js';
import { MemoryStore } from './services/memory-store.js';
import { PostgresStore } from './services/postgres-store.js';
import { createDb, runMigrations } from '@afterbyte/database';
import { StorageClient } from '@afterbyte/storage';
import { createLogger } from '@afterbyte/observability';

async function main(): Promise<void> {
  let config;
  let capabilities;
  try {
    const loaded = loadConfig(process.env);
    config = loaded.config;
    capabilities = capabilitiesOf(config);
    for (const warning of loaded.warnings) {
      console.warn(`[config] ${warning}`);
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[config] FATAL: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const log = createLogger({ service: 'afterbyte-api' });
  const configPayload = buildConfigPayload(config, capabilities);
  const storage = config.objectStorage ? new StorageClient(config.objectStorage) : null;

  // Postgres when DATABASE_URL is set (production); in-memory fallback for
  // dev/test. Migrations run first unless RUN_MIGRATIONS=false.
  let store: ReadStore;
  let database: 'postgres' | 'memory';
  let migrationError: string | null = null;
  let closeDb: (() => Promise<void>) | null = null;
  if (config.databaseUrl) {
    if ((process.env.RUN_MIGRATIONS ?? 'true').toLowerCase() !== 'false') {
      log.info('running database migrations');
      try {
        await runMigrations();
        log.info('migrations applied');
      } catch (err) {
        const cause = err instanceof Error ? (err.cause instanceof Error ? ` | cause: ${err.cause.message}` : '') : '';
        migrationError = (err instanceof Error ? err.message : String(err)) + cause;
        log.error({ err: migrationError }, 'database migrations FAILED — continuing without migrated schema');
      }
    }
    const { db, pool } = createDb(config.databaseUrl);
    store = new PostgresStore(db, { config: configPayload, storage });
    database = 'postgres';
    closeDb = () => pool.end();
    log.info('using postgres store (drizzle)');
  } else {
    store = new MemoryStore({ seedFixtures: config.useFixtureSeed, config: configPayload });
    database = 'memory';
    log.warn('DATABASE_URL not set — using in-memory store (dev/test fallback; not for production)');
  }
  const deps = defaultDependencies(config, capabilities, store, log, database, migrationError);
  deps.challenges.startSweeper();

  const fastify = await buildApp(deps);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    deps.challenges.stopSweeper();
    await fastify.close();
    if (closeDb) await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await fastify.listen({ port: config.port, host: config.host });
  log.info(
    {
      port: config.port,
      env: config.appEnv,
      database,
      capabilities,
      fixtureMode: config.useFixtureSeed,
    },
    'afterbyte api listening',
  );
}

main().catch((err) => {
  console.error('[bootstrap] FATAL:', err);
  process.exit(1);
});
