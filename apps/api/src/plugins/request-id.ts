import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';
import { runWithContext, parseTraceparent, newTraceContext } from '@afterbyte/observability';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

/**
 * Correlation: every request gets a UUID requestId (or reuses the client's
 * x-request-id), exposed as a response header, and runs inside an async
 * context so log lines pick it up. W3C traceparent is parsed when present
 * (OTel-compatible) so traces correlate across services.
 *
 * Wrapped in fastify-plugin so the hook is truly global across all
 * encapsulated route contexts.
 */
async function requestIdPluginFn(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', (request, reply, done) => {
    const incoming = request.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128
        ? incoming
        : randomUUID();
    request.requestId = requestId;
    reply.header('x-request-id', requestId);

    const incomingTrace = parseTraceparent(request.headers['traceparent'] as string | undefined);
    const trace = incomingTrace ?? newTraceContext();
    reply.header('traceparent', `00-${trace.traceId}-${trace.spanId}-00`);

    // Idiomatic per-request child logger (always correct) + async-local
    // context for deep log calls (works for the common Fastify hook chain).
    request.log = request.log.child({ requestId, traceId: trace.traceId });

    runWithContext({ requestId, traceId: trace.traceId, spanId: trace.spanId }, () => done());
  });
}

export const requestIdPlugin: FastifyPluginAsync = fp(requestIdPluginFn);
