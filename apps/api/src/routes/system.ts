import type { FastifyPluginAsync } from 'fastify';
import { buildLiveness, buildReadiness, type DependencyCheck } from '@afterbyte/observability';
import type { ApiConfig, Capabilities } from '../config.js';
import { noStore } from '../lib/cache.js';

export interface SystemRouteOptions {
  config: ApiConfig;
  capabilities: Capabilities;
  /** Honest database labeling for /health/ready. */
  database: 'postgres' | 'memory';
}

/**
 * System routes: health probes. No envelope here — probes must stay
 * machine-parseable and dependency-light.
 */
export const systemRoutes: FastifyPluginAsync<SystemRouteOptions> = async (fastify, deps) => {
  fastify.get('/health/live', async (_request, reply) => {
    noStore(reply);
    return buildLiveness('0.1.0', process.uptime());
  });

  fastify.get('/health/ready', async (_request, reply) => {
    noStore(reply);
    // Readiness reflects ONLY needed deps. Database is required; Redis and
    // object storage are optional capabilities -> degraded, never not_ready.
    // The database label reports the actual backing store honestly.
    const checks: DependencyCheck[] = [
      deps.database === 'postgres'
        ? { name: 'database', status: 'ok', detail: 'postgres (drizzle)' }
        : { name: 'database', status: 'ok', detail: 'memory store (dev/test fallback; set DATABASE_URL for postgres)' },
      {
        name: 'redis',
        status: deps.config.redisUrl ? 'ok' : 'degraded',
        detail: deps.config.redisUrl ? 'configured' : 'not configured; in-memory session fallback',
      },
      {
        name: 'object-storage',
        status: deps.capabilities.storage ? 'ok' : 'degraded',
        detail: deps.capabilities.storage ? 'configured' : 'not configured; asset uploads disabled',
      },
    ];
    const report = buildReadiness(checks, '0.1.0', process.uptime());
    if (report.status !== 'ready') reply.status(503);
    return report;
  });
};
