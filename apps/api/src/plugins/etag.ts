import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { createHash } from 'node:crypto';

/**
 * Weak ETags on public GET responses + If-None-Match -> 304.
 * Brief §12: use ETag/If-None-Match for public reads.
 *
 * The ETag covers the `data` payload only: envelope meta (requestId, asOf)
 * is volatile per request, so a full-payload hash could never revalidate.
 * A 304 therefore means "the data you hold is unchanged", which is the
 * correct revalidation semantic here.
 *
 * fastify-plugin wrapped so the onSend hook covers every route context.
 */
async function etagPluginFn(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'GET') return payload;
    if (typeof payload !== 'string') return payload;
    if (reply.getHeader('etag')) return payload;

    let hashInput = payload;
    try {
      const parsed = JSON.parse(payload) as { data?: unknown };
      if (parsed && typeof parsed === 'object' && 'data' in parsed) {
        hashInput = JSON.stringify(parsed.data);
      }
    } catch {
      // not JSON: hash the raw payload
    }
    const hash = createHash('sha256').update(hashInput).digest('base64url').slice(0, 32);
    const etag = `W/"${hash}"`;
    reply.header('etag', etag);

    const ifNoneMatch = request.headers['if-none-match'];
    if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').map((s) => s.trim()).includes(etag)) {
      reply.status(304);
      return '';
    }
    return payload;
  });
}

export const etagPlugin: FastifyPluginAsync = fp(etagPluginFn);
