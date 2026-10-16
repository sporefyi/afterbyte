import type { FastifyReply } from 'fastify';

/**
 * Cache policy per brief §14.
 * - Public home/list: short TTL (configurable, default 45s), must-revalidate.
 * - Version-specific immutable bytes: long immutable caching.
 * - Private responses: no-store, always.
 *
 * A privileged response must NEVER populate a public cache: every
 * authenticated route calls noStore() explicitly.
 */
export function publicShort(reply: FastifyReply, ttlSeconds: number): void {
  reply.header('Cache-Control', `public, max-age=${ttlSeconds}, must-revalidate`);
}

export function immutable(reply: FastifyReply): void {
  reply.header('Cache-Control', 'public, max-age=31536000, immutable');
}

export function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store, must-revalidate');
  reply.header('Pragma', 'no-cache');
}
