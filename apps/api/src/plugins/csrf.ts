import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { csrfTokensEqual, newCsrfToken } from '../services/auth.service.js';
import { failure } from '../lib/envelope.js';

export interface CsrfOptions {
  allowedOrigins: string[];
  cookieName?: string;
  headerName?: string;
  /**
   * URL patterns exempt from CSRF (no authenticated session can exist yet,
   * e.g. the login initiation/completion endpoints). Everything else that
   * mutates requires the double-submit token.
   */
  exempt?: RegExp[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for cookie-authenticated mutations: double-submit token
 * (cookie ab_csrf + x-csrf-token header, constant-time compare) plus an
 * explicit Origin/Referer check against the allowlist. Safe methods skip.
 * A missing or mismatched token is 403 CSRF_FAILED — never silently ignored.
 *
 * fastify-plugin wrapped so the check covers every route context.
 */
async function csrfPluginFn(fastify: FastifyInstance, opts: CsrfOptions): Promise<void> {
  const cookieName = opts.cookieName ?? 'ab_csrf';
  const headerName = (opts.headerName ?? 'x-csrf-token').toLowerCase();

  fastify.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method.toUpperCase())) return;
    if ((opts.exempt ?? []).some((re) => re.test(request.url.split('?')[0]))) return;

    const cookieToken = request.cookies[cookieName];
    const headerToken = request.headers[headerName];
    if (typeof cookieToken !== 'string' || typeof headerToken !== 'string' || !csrfTokensEqual(cookieToken, headerToken)) {
      return reply.status(403).send(failure('CSRF_FAILED', 'CSRF token missing or mismatched', request.requestId));
    }

    const origin = request.headers.origin ?? request.headers.referer;
    if (origin && opts.allowedOrigins.length > 0) {
      let originHost: string;
      try {
        originHost = new URL(origin).origin;
      } catch {
        return reply.status(403).send(failure('CSRF_FAILED', 'Unparseable origin', request.requestId));
      }
      if (!opts.allowedOrigins.includes(originHost)) {
        return reply.status(403).send(failure('CSRF_FAILED', 'Origin not allowed', request.requestId));
      }
    }
  });
}

export const csrfPlugin: FastifyPluginAsync<CsrfOptions> = fp(csrfPluginFn);

/** Issues a fresh CSRF token (also sets the readable cookie). */
export function issueCsrfToken(): string {
  return newCsrfToken();
}
