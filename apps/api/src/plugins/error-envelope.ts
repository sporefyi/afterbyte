import type { FastifyInstance, FastifyPluginAsync, FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import { failure, ERROR_STATUS, type ErrorCode } from '../lib/envelope.js';

/**
 * Maps every error (validation, auth, unexpected) into the brief §12 error
 * envelope. Fastify schema validation failures become 422 VALIDATION_FAILED
 * with fieldErrors; unknown errors become 500 INTERNAL_ERROR without
 * leaking internals.
 *
 * fastify-plugin wrapped: the error handler must cover every route context.
 */
async function errorEnvelopePluginFn(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler((error: FastifyError & { fieldErrors?: { field: string; message: string }[] }, request, reply) => {
    const requestId = (request as { requestId?: string }).requestId ?? 'unknown';

    if (error.validation) {
      const fieldErrors = (error.validation as { instancePath?: string; message?: string }[]).map((v) => ({
        field: v.instancePath?.replace(/^\//, '') || '(body)',
        message: v.message ?? 'invalid value',
      }));
      return reply.status(422).send(failure('VALIDATION_FAILED', 'Request validation failed', requestId, { fieldErrors }));
    }

    const status = error.statusCode ?? 500;
    const code = (error as { code?: string }).code as ErrorCode | undefined;
    if (code && code in ERROR_STATUS) {
      return reply
        .status(ERROR_STATUS[code] ?? status)
        .send(failure(code, error.message, requestId, { retryable: false }));
    }

    if (status === 401) return reply.status(401).send(failure('UNAUTHORIZED', 'Authentication required', requestId));
    if (status === 403) return reply.status(403).send(failure('FORBIDDEN', 'Forbidden', requestId));
    if (status === 404) return reply.status(404).send(failure('NOT_FOUND', 'Not found', requestId));
    if (status === 429) return reply.status(429).send(failure('RATE_LIMITED', 'Too many requests', requestId, { retryable: true }));

    fastify.log.error({ err: error, requestId }, 'unhandled error');
    return reply.status(500).send(failure('INTERNAL_ERROR', 'Internal server error', requestId));
  });

  fastify.setNotFoundHandler((request, reply) => {
    const requestId = (request as { requestId?: string }).requestId ?? 'unknown';
    return reply.status(404).send(failure('NOT_FOUND', `No route for ${request.method} ${request.url}`, requestId));
  });
}

export const errorEnvelopePlugin: FastifyPluginAsync = fp(errorEnvelopePluginFn);
