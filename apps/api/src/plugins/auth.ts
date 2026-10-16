import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
  preHandlerAsyncHookHandler,
} from 'fastify';
import fp from 'fastify-plugin';
import type { Session, SessionStore, Role } from '../services/auth.service.js';
import { failure } from '../lib/envelope.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
}

export interface SessionAuthOptions {
  sessionStore: SessionStore;
  idleTimeoutMs: number;
  cookieName?: string;
}

/** Loads the session from the HttpOnly cookie; enforces idle + absolute expiry. */
async function sessionAuthPluginFn(fastify: FastifyInstance, opts: SessionAuthOptions): Promise<void> {
  const cookieName = opts.cookieName ?? 'ab_session';
  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    request.session = null;
    const sessionId = request.cookies[cookieName];
    if (!sessionId) return;
    const session = await opts.sessionStore.get(sessionId);
    if (!session) return;
    const now = Date.now();
    if (now > session.absoluteExpiry || now - session.lastSeenAt > opts.idleTimeoutMs) {
      await opts.sessionStore.destroy(sessionId);
      return;
    }
    await opts.sessionStore.touch(sessionId);
    request.session = session;
  });
}

// fastify-plugin: the session loader must run for every route context.
export const sessionAuthPlugin: FastifyPluginAsync<SessionAuthOptions> = fp(sessionAuthPluginFn);

function deny(reply: FastifyReply, request: FastifyRequest, code: 'UNAUTHORIZED' | 'FORBIDDEN', message: string) {
  return reply
    .status(code === 'UNAUTHORIZED' ? 401 : 403)
    .send(failure(code, message, request.requestId));
}

/** Any authenticated session. */
export function requireAuth(): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    if (!request.session) return deny(reply, request, 'UNAUTHORIZED', 'Authentication required');
  };
}

/** At least one of the listed roles. Admin routes return 403 without the grant. */
export function requireRole(...roles: Role[]): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    if (!request.session) return deny(reply, request, 'UNAUTHORIZED', 'Authentication required');
    if (!roles.some((r) => request.session!.roles.includes(r))) {
      return deny(reply, request, 'FORBIDDEN', 'Insufficient role for this operation');
    }
  };
}

/** Explicit capability grant (e.g. treasury for payout/refund approval). */
export function requireCapability(capability: string): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    if (!request.session) return deny(reply, request, 'UNAUTHORIZED', 'Authentication required');
    if (!request.session.capabilities.includes(capability)) {
      return deny(reply, request, 'FORBIDDEN', `Missing capability: ${capability}`);
    }
  };
}

/** Object-level ownership: bookmarks, orders, notifications belong to the caller. */
export function ownerCheck(getOwnerId: (request: FastifyRequest) => string | null): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    if (!request.session) return deny(reply, request, 'UNAUTHORIZED', 'Authentication required');
    const ownerId = getOwnerId(request);
    if (!ownerId || request.session.userId !== ownerId) {
      return deny(reply, request, 'FORBIDDEN', 'You do not own this resource');
    }
  };
}
