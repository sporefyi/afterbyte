import type { FastifyPluginAsync } from 'fastify';
import type { RouteDeps } from './context.js';
import { dataModeOf } from './context.js';
import { success, failure } from '../lib/envelope.js';
import { normalizeLimit, MAX_LIMIT } from '../lib/pagination.js';
import { publicShort, noStore } from '../lib/cache.js';
import { attachSseStream, resolveCursor, eventsAfter, formatResyncEvent, toEventRecord } from '../sse.js';
import type { PublicEventType } from '../services/store.js';

const EVENT_TYPES: PublicEventType[] = [
  'dossier.published',
  'dossier.corrected',
  'dossier.retracted',
  'subject.status_changed',
  'research.started',
  'research.completed',
  'receipt.finalized',
];

/**
 * Public read routes (brief §12). All work with zero optional providers
 * configured; provider absence is reported in /config, never a failure.
 */
export const publicRoutes: FastifyPluginAsync<RouteDeps> = async (fastify, deps) => {
  const { store, config, capabilities } = deps;
  const ttl = config.publicCacheTtlSeconds;

  fastify.get('/config', async (request, reply) => {
    publicShort(reply, ttl);
    return success(await store.getConfig(), { requestId: request.requestId, dataMode: dataModeOf(deps) });
  });

  fastify.get('/home', async (request, reply) => {
    publicShort(reply, ttl);
    return success(await store.getHome(), { requestId: request.requestId, dataMode: dataModeOf(deps) });
  });

  fastify.get('/stats', async (request, reply) => {
    publicShort(reply, ttl);
    return success(await store.getStats(), { requestId: request.requestId, dataMode: dataModeOf(deps) });
  });

  fastify.get(
    '/search/suggest',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 256 },
            limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
          },
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const { q, limit } = request.query as { q: string; limit?: number };
      const items = await store.suggest(q, Math.min(limit ?? 10, 20));
      return success(items, { requestId: request.requestId, dataMode: dataModeOf(deps) });
    },
  );

  fastify.get(
    '/activity',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
            cursor: { type: 'string', maxLength: 2048 },
            eventType: { type: 'string', enum: EVENT_TYPES },
          },
        },
      },
    },
    async (request, reply) => {
      noStore(reply); // activity feed is live; never cached
      const { limit, cursor, eventType } = request.query as {
        limit?: number;
        cursor?: string;
        eventType?: PublicEventType;
      };
      const { items, nextCursor } = await store.listActivity({ limit: normalizeLimit(limit), cursor }, eventType);
      return success(items, { requestId: request.requestId, dataMode: dataModeOf(deps), nextCursor });
    },
  );

  fastify.get('/collections/:slug', async (request, reply) => {
    publicShort(reply, ttl);
    const { slug } = request.params as { slug: string };
    const collection = await store.getCollection(slug);
    if (!collection) {
      return reply.status(404).send(failure('NOT_FOUND', `Collection not found: ${slug}`, request.requestId));
    }
    return success(collection, { requestId: request.requestId, dataMode: dataModeOf(deps) });
  });

  fastify.get('/receipts/:id', async (request, reply) => {
    publicShort(reply, ttl);
    const { id } = request.params as { id: string };
    const receipt = await store.getReceipt(id);
    if (!receipt) {
      return reply.status(404).send(failure('NOT_FOUND', `Receipt not found: ${id}`, request.requestId));
    }
    return success(receipt, { requestId: request.requestId, dataMode: dataModeOf(deps) });
  });

  fastify.get('/methodology', async (request, reply) => {
    publicShort(reply, ttl);
    return success(await store.getMethodology(), { requestId: request.requestId, dataMode: dataModeOf(deps) });
  });

  fastify.get('/status', async (request, reply) => {
    publicShort(reply, ttl);
    return success(await store.getStatus(), { requestId: request.requestId, dataMode: dataModeOf(deps) });
  });

  fastify.get('/share/dossiers/:slug/:version', async (request, reply) => {
    publicShort(reply, ttl);
    const { slug, version } = request.params as { slug: string; version: string };
    const share = await store.getShare(slug, Number(version));
    if (!share) {
      return reply.status(404).send(failure('NOT_FOUND', `Share not found: ${slug} v${version}`, request.requestId));
    }
    return success(share, { requestId: request.requestId, dataMode: dataModeOf(deps) });
  });

  // Public SSE stream. Heartbeats every 20s, Last-Event-ID resync, 7-day retention.
  fastify.get('/events/stream', async (request, reply) => {
    const headerId = request.headers['last-event-id'];
    const queryId = (request.query as { lastEventId?: string }).lastEventId;
    const lastEventId = (typeof headerId === 'string' ? headerId : undefined) ?? queryId;

    // Build the retained event list from the activity read model.
    const { items } = await store.listActivity({ limit: MAX_LIMIT });
    const events = items.map(toEventRecord);
    const cursor = resolveCursor(lastEventId, events);

    const stream = attachSseStream(request, reply);
    if (cursor.kind === 'resync_required') {
      (reply.raw as unknown as { write: (s: string) => void }).write(formatResyncEvent());
    } else {
      for (const e of eventsAfter(events, cursor.afterSequenceId)) stream.publish(e);
    }
    // NOTE: in the worker deployment, new published events are pushed into
    // this stream via the shared event bus. With the memory store there is
    // no cross-process bus yet; the stream stays open with heartbeats until
    // the client disconnects. Await client close to keep the handler alive.
    await new Promise<void>((resolve) => {
      request.raw.on('close', () => {
        stream.close();
        resolve();
      });
    });
    return reply;
  });
};
