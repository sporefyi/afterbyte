import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { RouteDeps } from './context.js';
import { failure } from '../lib/envelope.js';
import { noStore } from '../lib/cache.js';
import { requireAuth } from '../plugins/auth.js';

/**
 * Payment endpoints (brief §12, §15 — Release B).
 *
 * Honest disabled state: every endpoint returns 503 FEATURE_UNAVAILABLE
 * unless PAYMENTS_ENABLED=true AND treasury + USDC mint are configured.
 * There is no decorative CTA path — the frontend hides payment controls via
 * /config features.paymentsEnabled. When enabled (future lane), these routes
 * delegate to the payments service with idempotency keys and the on-chain
 * verification rules from brief §15.
 */
export const paymentRoutes: FastifyPluginAsync<RouteDeps> = async (fastify, deps) => {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    noStore(reply);
    if (!deps.config.payments.enabled) {
      return reply
        .status(503)
        .send(
          failure(
            'FEATURE_UNAVAILABLE',
            'Payments are disabled. Investigation orders and payment intents are not available in Release A.',
            request.requestId,
          ),
        );
    }
    // Release B: delegate to the payments service (idempotency-key scoped to
    // user+route, on-chain finalized verification per brief §15). Unreachable
    // today because config.payments.enabled is false without treasury+mint.
    return reply
      .status(503)
      .send(failure('FEATURE_UNAVAILABLE', 'Payments are not yet available.', request.requestId));
  };

  const authed = { preHandler: [requireAuth()] };
  fastify.post('/investigation-orders', authed, handler);
  fastify.get('/investigation-orders/:id', authed, handler);
  fastify.post('/investigation-orders/:id/accept-quote', authed, handler);
  fastify.post('/payment-intents', authed, handler);
  fastify.get('/payment-intents/:id', authed, handler);
  fastify.post('/payment-intents/:id/submit-signature', authed, handler);
  fastify.post('/investigation-orders/:id/refund-request', authed, handler);
  fastify.get('/refunds/:id', authed, handler);
};
