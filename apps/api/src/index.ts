/**
 * API server bootstrap. Validates config on startup: core missing
 * credentials fail fast with a clear error naming the variable;
 * optional missing providers disable capabilities (reported by /config).
 */
import { loadConfig, capabilitiesOf, ConfigError } from './config.js';
import { buildApp, buildConfigPayload, defaultDependencies } from './app.js';
import { MemoryStore } from './services/memory-store.js';
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
  const store = new MemoryStore({
    seedFixtures: config.useFixtureSeed,
    config: buildConfigPayload(config, capabilities),
  });
  const deps = defaultDependencies(config, capabilities, store, log);
  deps.challenges.startSweeper();

  const fastify = await buildApp(deps);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    deps.challenges.stopSweeper();
    await fastify.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await fastify.listen({ port: config.port, host: config.host });
  log.info(
    {
      port: config.port,
      env: config.appEnv,
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
