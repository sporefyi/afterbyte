import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import cookie from '@fastify/cookie';
import type { ApiConfig, Capabilities } from './config.js';
import type { ReadStore, ConfigPayload } from './services/store.js';
import type { ChallengeStore, SessionStore } from './services/auth.service.js';
import { MemorySessionStore, ChallengeStore as ChallengeStoreImpl } from './services/auth.service.js';
import { AdminStore } from './services/admin.service.js';
import type { Logger } from '@afterbyte/observability';
import { requestIdPlugin } from './plugins/request-id.js';
import { errorEnvelopePlugin } from './plugins/error-envelope.js';
import { sessionAuthPlugin } from './plugins/auth.js';
import { csrfPlugin } from './plugins/csrf.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { etagPlugin } from './plugins/etag.js';
import { securityPlugin } from './plugins/security.js';
import { systemRoutes } from './routes/system.js';
import { publicRoutes } from './routes/public.js';
import { dossierRoutes } from './routes/dossiers.js';
import { identityRoutes } from './routes/identity.js';
import { adminRoutes } from './routes/admin.js';
import { paymentRoutes } from './routes/payments.js';

export interface AppDependencies {
  config: ApiConfig;
  capabilities: Capabilities;
  store: ReadStore;
  /** Which read store backs the API: 'postgres' (production) or 'memory' (dev/test fallback). */
  database: 'postgres' | 'memory';
  challenges: ChallengeStore;
  sessions: SessionStore;
  adminStore: AdminStore;
  log: Logger;
}

export function buildConfigPayload(config: ApiConfig, capabilities: Capabilities): ConfigPayload {
  return {
    brand: { name: 'AFTERBYTE', tagline: 'The internet moves on. We follow up.' },
    canonicalUrls: {
      site: config.publicSiteUrl,
      api: config.apiOrigin,
    },
    features: {
      paymentsEnabled: capabilities.payments,
      tokenEnabled: false,
      researchEnabled: capabilities.models,
    },
    chain: `solana:${config.solana.cluster}`,
    programId: config.solana.programId ?? null,
    acceptedPaymentAssets: capabilities.payments ? ['SOL', 'USDC'] : [],
    providerStatus: {
      search: capabilities.search ? 'operational' : 'unavailable',
      models: capabilities.models ? 'operational' : 'unavailable',
      receipts: capabilities.receipts ? 'operational' : 'unavailable',
      storage: capabilities.storage ? 'operational' : 'unavailable',
    },
  };
}

/** Fastify instance builder. Pure composition — no env reads here. */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const fastify = Fastify({
    loggerInstance: deps.log as unknown as FastifyBaseLogger,
    trustProxy: deps.config.appEnv !== 'dev',
    bodyLimit: 2 * 1024 * 1024,
  });

  // Global plugins first: errors, correlation, security, cookies, sessions,
  // CSRF, ETags, rate limits.
  await fastify.register(errorEnvelopePlugin);
  await fastify.register(requestIdPlugin);
  await fastify.register(securityPlugin, {
    allowedOrigins: deps.config.allowedOrigins,
    appEnv: deps.config.appEnv,
  });
  await fastify.register(cookie);
  await fastify.register(sessionAuthPlugin, {
    sessionStore: deps.sessions,
    idleTimeoutMs: deps.config.sessionIdleMinutes * 60 * 1000,
  });
  await fastify.register(csrfPlugin, {
    allowedOrigins: deps.config.allowedOrigins,
    exempt: [/^\/api\/v1\/auth\/(challenge|verify)$/],
  });
  await fastify.register(etagPlugin);
  await fastify.register(rateLimitPlugin, { max: 300, windowMs: 60_000 });

  const routeDeps = {
    config: deps.config,
    capabilities: deps.capabilities,
    store: deps.store,
    challenges: deps.challenges,
    sessions: deps.sessions,
    log: deps.log,
  };

  // System probes at root (no /api/v1 prefix, no envelope).
  await fastify.register(systemRoutes, {
    config: deps.config,
    capabilities: deps.capabilities,
    database: deps.database,
  });

  // Versioned API.
  await fastify.register(publicRoutes, { ...routeDeps, prefix: '/api/v1' });
  await fastify.register(dossierRoutes, { ...routeDeps, prefix: '/api/v1' });
  await fastify.register(identityRoutes, { ...routeDeps, prefix: '/api/v1' });
  await fastify.register(paymentRoutes, { ...routeDeps, prefix: '/api/v1' });
  await fastify.register(adminRoutes, { ...routeDeps, adminStore: deps.adminStore, prefix: '/api/v1/admin' });

  return fastify;
}

export function defaultDependencies(
  config: ApiConfig,
  capabilities: Capabilities,
  store: ReadStore,
  log: Logger,
  database: 'postgres' | 'memory' = 'memory',
): AppDependencies {
  return {
    config,
    capabilities,
    store,
    database,
    challenges: new ChallengeStoreImpl(),
    sessions: new MemorySessionStore(),
    adminStore: new AdminStore(),
    log,
  };
}
