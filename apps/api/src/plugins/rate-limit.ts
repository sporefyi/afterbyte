import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { failure } from '../lib/envelope.js';

export interface RateLimitOptions {
  /** requests per window for general traffic */
  max: number;
  windowMs: number;
}

/**
 * Rate limiting. Exceeding the limit returns 429 RATE_LIMITED with
 * Retry-After, in the standard error envelope. Stricter per-route caps are
 * set on sensitive routes (auth challenge/verify, admin) via route config.
 */
export const rateLimitPlugin: FastifyPluginAsync<RateLimitOptions> = async (fastify, opts) => {
  await fastify.register(rateLimit, {
    global: true,
    max: opts.max,
    timeWindow: opts.windowMs,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (request, context) => {
      const requestId = (request as { requestId?: string }).requestId ?? 'unknown';
      return failure('RATE_LIMITED', `Rate limit exceeded; retry after ${Math.ceil(context.ttl / 1000)}s`, requestId, {
        retryable: true,
      });
    },
    addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
  });
};
