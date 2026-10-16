import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import type { RouteDeps } from './context.js';
import { dataModeOf } from './context.js';
import { success, failure } from '../lib/envelope.js';
import { normalizeLimit, MAX_LIMIT } from '../lib/pagination.js';
import { publicShort, immutable, noStore } from '../lib/cache.js';
import type { Category, LifecycleStatus, DossierSort } from '../services/store.js';

const SORTS: DossierSort[] = ['relevance', 'recently_updated', 'recently_verified'];
const CATEGORIES: Category[] = ['app', 'website', 'game', 'meme', 'community', 'crypto'];
const LIFECYCLES: LifecycleStatus[] = ['active', 'declining', 'uncertain', 'dormant', 'defunct'];

const listQuerySchema = {
  type: 'object',
  properties: {
    q: { type: 'string', minLength: 1, maxLength: 256 },
    category: { type: 'string', enum: CATEGORIES },
    lifecycleStatus: { type: 'string', enum: LIFECYCLES },
    era: { type: 'string', maxLength: 64 },
    sort: { type: 'string', enum: SORTS, default: 'relevance' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
    cursor: { type: 'string', maxLength: 2048 },
  },
};

const pageQuerySchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
    cursor: { type: 'string', maxLength: 2048 },
  },
};

/** Dossier read routes (brief §12). Current URLs are mutable -> short TTL + invalidation; canonical bytes are immutable. */
export const dossierRoutes: FastifyPluginAsync<RouteDeps> = async (fastify, deps) => {
  const { store, config } = deps;
  const ttl = config.publicCacheTtlSeconds;

  fastify.get('/dossiers', { schema: { querystring: listQuerySchema } }, async (request, reply) => {
    publicShort(reply, ttl);
    const q = request.query as {
      q?: string;
      category?: Category;
      lifecycleStatus?: LifecycleStatus;
      era?: string;
      sort?: DossierSort;
      limit?: number;
      cursor?: string;
    };
    const { items, nextCursor } = await store.listDossiers({
      q: q.q,
      category: q.category,
      lifecycleStatus: q.lifecycleStatus,
      era: q.era,
      sort: q.sort ?? 'relevance',
      limit: normalizeLimit(q.limit),
      cursor: q.cursor,
    });
    return success(items, { requestId: request.requestId, dataMode: dataModeOf(deps), nextCursor });
  });

  fastify.get('/dossiers/:slug', async (request, reply) => {
    publicShort(reply, ttl);
    const { slug } = request.params as { slug: string };
    const dossier = await store.getDossier(slug);
    if (!dossier) {
      return reply.status(404).send(failure('NOT_FOUND', `Dossier not found: ${slug}`, request.requestId));
    }
    return success(dossier, { requestId: request.requestId, dataMode: dataModeOf(deps) });
  });

  fastify.get('/dossiers/:slug/versions', { schema: { querystring: pageQuerySchema } }, async (request, reply) => {
    publicShort(reply, ttl);
    const { slug } = request.params as { slug: string };
    const { limit, cursor } = request.query as { limit?: number; cursor?: string };
    const result = await store.listVersions(slug, { limit: normalizeLimit(limit), cursor });
    if (!result) {
      return reply.status(404).send(failure('NOT_FOUND', `Dossier not found: ${slug}`, request.requestId));
    }
    return success(result.items, { requestId: request.requestId, dataMode: dataModeOf(deps), nextCursor: result.nextCursor });
  });

  fastify.get('/dossiers/:slug/versions/:version', async (request, reply) => {
    immutable(reply);
    const { slug, version } = request.params as { slug: string; version: string };
    const dossier = await store.getVersion(slug, Number(version));
    if (!dossier) {
      return reply.status(404).send(failure('NOT_FOUND', `Version not found: ${slug} v${version}`, request.requestId));
    }
    return success(dossier, { requestId: request.requestId, dataMode: dataModeOf(deps) });
  });

  // Canonical bytes: NOT the JSON envelope — hash verification must not
  // depend on the ordinary response envelope (brief §12).
  fastify.get('/dossiers/:slug/versions/:version/canonical', async (request, reply) => {
    const { slug, version } = request.params as { slug: string; version: string };
    const canon = await store.getCanonical(slug, Number(version));
    if (!canon) {
      return reply.status(404).send(failure('NOT_FOUND', `Canonical bytes not found: ${slug} v${version}`, request.requestId));
    }
    const digest = createHash('sha256').update(canon.bytes).digest('hex');
    if (digest !== canon.sha256) {
      return reply.status(500).send(failure('INTERNAL_ERROR', 'Canonical digest mismatch', request.requestId));
    }
    immutable(reply);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Digest', `sha-256=${Buffer.from(canon.sha256, 'hex').toString('base64')}`);
    reply.header('X-Content-SHA256', canon.sha256);
    return reply.send(canon.bytes);
  });

  const subresource = (
    path: string,
    list: (
      slug: string,
      page: { limit: number; cursor?: string },
    ) => Promise<{ items: unknown[]; nextCursor: string | null } | null>,
  ) => {
    fastify.get(path, { schema: { querystring: pageQuerySchema } }, async (request, reply) => {
      publicShort(reply, ttl);
      const { slug } = request.params as { slug: string };
      const { limit, cursor } = request.query as { limit?: number; cursor?: string };
      let result;
      try {
        result = await list(slug, { limit: normalizeLimit(limit), cursor });
      } catch (err) {
        if ((err as Error & { code?: string }).code === 'VALIDATION_FAILED') {
          return reply.status(422).send(failure('VALIDATION_FAILED', 'Invalid cursor', request.requestId));
        }
        throw err;
      }
      if (!result) {
        return reply.status(404).send(failure('NOT_FOUND', `Dossier not found: ${slug}`, request.requestId));
      }
      return success(result.items, { requestId: request.requestId, dataMode: dataModeOf(deps), nextCursor: result.nextCursor });
    });
  };

  subresource('/dossiers/:slug/timeline', async (s, p) => await store.listTimeline(s, p));
  subresource('/dossiers/:slug/sources', async (s, p) => await store.listSources(s, p));
  subresource('/dossiers/:slug/metrics', async (s, p) => await store.listMetrics(s, p));
  subresource('/dossiers/:slug/relations', async (s, p) => await store.listRelations(s, p));
  // Editorial diffs across published versions. no-store: privileged-adjacent
  // content that must never populate a public cache.
  fastify.get('/dossiers/:slug/changes', { schema: { querystring: pageQuerySchema } }, async (request, reply) => {
    noStore(reply);
    const { slug } = request.params as { slug: string };
    const { limit, cursor } = request.query as { limit?: number; cursor?: string };
    const result = await store.listChanges(slug, { limit: normalizeLimit(limit), cursor });
    if (!result) {
      return reply.status(404).send(failure('NOT_FOUND', `Dossier not found: ${slug}`, request.requestId));
    }
    return success(result.items, { requestId: request.requestId, dataMode: dataModeOf(deps), nextCursor: result.nextCursor });
  });
};
