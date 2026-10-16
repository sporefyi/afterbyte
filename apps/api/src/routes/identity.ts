import type { FastifyPluginAsync } from 'fastify';
import type { RouteDeps } from './context.js';
import { dataModeOf } from './context.js';
import { success, failure } from '../lib/envelope.js';
import { noStore } from '../lib/cache.js';
import { requireAuth } from '../plugins/auth.js';
import {
  buildSignInMessage,
  verifyChallenge,
  isValidSolanaAddress,
  newRequestId,
  newNonce,
  newSessionId,
  newCsrfToken,
  type SignInFlow,
  type Session,
} from '../services/auth.service.js';
import { randomUUID } from 'node:crypto';

const SESSION_COOKIE = 'ab_session';
const CSRF_COOKIE = 'ab_csrf';

function cookieOpts(deps: RouteDeps, maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: deps.config.sessionCookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/**
 * Identity routes (brief §11 + §12): wallet challenge/verify, session
 * lifecycle, and personal endpoints with object-level ownership checks.
 * All responses are no-store — private data must never populate a cache.
 */
export const identityRoutes: FastifyPluginAsync<RouteDeps> = async (fastify, deps) => {
  const { challenges, sessions, config } = deps;

  fastify.post(
    '/auth/challenge',
    {
      schema: {
        body: {
          type: 'object',
          required: ['address'],
          properties: {
            address: { type: 'string', minLength: 32, maxLength: 64 },
            flow: { type: 'string', enum: ['solana-sign-in', 'sign-message'], default: 'solana-sign-in' },
          },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      noStore(reply);
      const { address, flow } = request.body as { address: string; flow?: SignInFlow };
      const selectedFlow: SignInFlow = flow ?? 'solana-sign-in';
      if (!isValidSolanaAddress(address)) {
        return reply.status(422).send(failure('VALIDATION_FAILED', 'Invalid Solana address', request.requestId));
      }
      const now = new Date();
      const issuedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
      const requestId = newRequestId();
      const domain = new URL(config.apiOrigin || config.publicSiteUrl || 'http://localhost:3000').host;
      const uri = `${config.apiOrigin || config.publicSiteUrl || 'http://localhost:3000'}/api/v1/auth/verify`;
      const message = buildSignInMessage({
        domain,
        uri,
        address,
        nonce: newNonce(),
        issuedAt,
        expiresAt,
        requestId,
        flow: selectedFlow,
      });
      challenges.issue({
        requestId,
        domain,
        uri,
        address,
        nonce: message.match(/^Nonce: (.+)$/m)?.[1] ?? '',
        issuedAt,
        expiresAt,
        message,
        flow: selectedFlow,
        expiresAtMs: now.getTime() + 5 * 60 * 1000,
      });
      return success(
        { requestId, message, expiresAt, flow: selectedFlow },
        { requestId: request.requestId },
      );
    },
  );

  fastify.post(
    '/auth/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['requestId', 'signature'],
          properties: {
            requestId: { type: 'string', minLength: 1, maxLength: 128 },
            signature: { type: 'string', minLength: 32, maxLength: 128 },
            flow: { type: 'string', enum: ['solana-sign-in', 'sign-message'], default: 'solana-sign-in' },
          },
        },
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      noStore(reply);
      const { requestId, signature, flow } = request.body as {
        requestId: string;
        signature: string;
        flow?: SignInFlow;
      };
      const result = verifyChallenge(challenges, { requestId, signature, flow: flow ?? 'solana-sign-in' });
      if (!result.ok) {
        const message =
          result.reason === 'expired' || result.reason === 'missing'
            ? 'Challenge expired or not found'
            : result.reason === 'replayed'
              ? 'Challenge already used'
              : 'Signature verification failed';
        const code = result.reason === 'expired' ? 'CHALLENGE_EXPIRED' : 'UNAUTHORIZED';
        return reply.status(401).send(failure(code, message, request.requestId));
      }
      const { record } = result;
      // First public signup must never become admin (brief §11): new wallets
      // get the reader role; elevation happens only via the audited bootstrap.
      const userId = randomUUID();
      const nowMs = Date.now();
      const session: Session = {
        id: newSessionId(),
        userId,
        address: record.address,
        roles: ['reader'],
        capabilities: [],
        createdAt: nowMs,
        lastSeenAt: nowMs,
        absoluteExpiry: nowMs + config.sessionAbsoluteHours * 3600 * 1000,
      };
      await sessions.create(session);
      deps.store.getOrCreateProfile(userId, record.address);

      const csrfToken = newCsrfToken();
      reply.setCookie(SESSION_COOKIE, session.id, cookieOpts(deps, config.sessionAbsoluteHours * 3600));
      reply.setCookie(CSRF_COOKIE, csrfToken, {
        httpOnly: false, // readable by JS: double-submit pattern requires this
        secure: config.sessionCookieSecure,
        sameSite: 'lax' as const,
        path: '/',
        maxAge: config.sessionAbsoluteHours * 3600,
      });
      return success(
        { userId, address: record.address, roles: session.roles, csrfToken },
        { requestId: request.requestId },
      );
    },
  );

  fastify.post('/auth/logout', { preHandler: [requireAuth()] }, async (request, reply) => {
    noStore(reply);
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) await sessions.destroy(sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return success({ loggedOut: true }, { requestId: request.requestId });
  });

  fastify.get('/me', { preHandler: [requireAuth()] }, async (request, reply) => {
    noStore(reply);
    const profile = deps.store.getOrCreateProfile(request.session!.userId, request.session!.address);
    return success(
      { ...profile, roles: request.session!.roles, capabilities: request.session!.capabilities },
      { requestId: request.requestId },
    );
  });

  // ---- bookmarks ----
  fastify.get('/me/bookmarks', { preHandler: [requireAuth()] }, async (request, reply) => {
    noStore(reply);
    return success(deps.store.listBookmarks(request.session!.userId), { requestId: request.requestId });
  });
  fastify.put(
    '/me/bookmarks/:subjectId',
    {
      preHandler: [requireAuth()],
      schema: {
        body: {
          type: 'object',
          required: ['dossierSlug'],
          properties: { dossierSlug: { type: 'string', minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const { subjectId } = request.params as { subjectId: string };
      const { dossierSlug } = request.body as { dossierSlug: string };
      return success(deps.store.putBookmark(request.session!.userId, subjectId, dossierSlug), {
        requestId: request.requestId,
      });
    },
  );
  fastify.delete('/me/bookmarks/:subjectId', { preHandler: [requireAuth()] }, async (request, reply) => {
    noStore(reply);
    const { subjectId } = request.params as { subjectId: string };
    const removed = deps.store.deleteBookmark(request.session!.userId, subjectId);
    if (!removed) return reply.status(404).send(failure('NOT_FOUND', 'Bookmark not found', request.requestId));
    return success({ removed: true }, { requestId: request.requestId });
  });

  // ---- watchlist ----
  fastify.get('/me/watchlist', { preHandler: [requireAuth()] }, async (request, reply) => {
    noStore(reply);
    return success(deps.store.listWatchlist(request.session!.userId), { requestId: request.requestId });
  });
  fastify.put(
    '/me/watchlist/:subjectId',
    {
      preHandler: [requireAuth()],
      schema: {
        body: {
          type: 'object',
          required: ['dossierSlug'],
          properties: { dossierSlug: { type: 'string', minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const { subjectId } = request.params as { subjectId: string };
      const { dossierSlug } = request.body as { dossierSlug: string };
      return success(deps.store.putWatchlist(request.session!.userId, subjectId, dossierSlug), {
        requestId: request.requestId,
      });
    },
  );
  fastify.delete('/me/watchlist/:subjectId', { preHandler: [requireAuth()] }, async (request, reply) => {
    noStore(reply);
    const { subjectId } = request.params as { subjectId: string };
    const removed = deps.store.deleteWatchlist(request.session!.userId, subjectId);
    if (!removed) return reply.status(404).send(failure('NOT_FOUND', 'Watchlist entry not found', request.requestId));
    return success({ removed: true }, { requestId: request.requestId });
  });

  // ---- notifications (read state only; object-level ownership) ----
  fastify.get('/me/notifications', { preHandler: [requireAuth()] }, async (request, reply) => {
    noStore(reply);
    return success(deps.store.listNotifications(request.session!.userId), { requestId: request.requestId });
  });
  fastify.patch(
    '/me/notifications/:id',
    {
      preHandler: [requireAuth()],
      schema: { body: { type: 'object', required: ['read'], properties: { read: { type: 'boolean' } } } },
    },
    async (request, reply) => {
      noStore(reply);
      const { id } = request.params as { id: string };
      const owned = deps.store.listNotifications(request.session!.userId).some((n) => n.id === id);
      if (!owned) return reply.status(404).send(failure('NOT_FOUND', 'Notification not found', request.requestId));
      const updated = deps.store.markNotificationRead(request.session!.userId, id);
      return success(updated, { requestId: request.requestId });
    },
  );

  // ---- submissions & corrections ----
  fastify.post(
    '/submissions',
    {
      preHandler: [requireAuth()],
      schema: {
        body: {
          type: 'object',
          required: ['subjectName', 'candidateUrls', 'reason'],
          properties: {
            subjectName: { type: 'string', minLength: 2, maxLength: 200 },
            candidateUrls: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', format: 'uri', maxLength: 2048 } },
            reason: { type: 'string', minLength: 10, maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const ticket = deps.store.createSubmission(
        request.session!.userId,
        request.body as { subjectName: string; candidateUrls: string[]; reason: string },
      );
      return reply.status(201).send(success(ticket, { requestId: request.requestId }));
    },
  );

  fastify.post(
    '/dossiers/:slug/corrections',
    {
      preHandler: [requireAuth()],
      schema: {
        body: {
          type: 'object',
          required: ['claimedIssue', 'evidenceUrls', 'explanatoryText'],
          properties: {
            claimedIssue: { type: 'string', minLength: 10, maxLength: 2000 },
            evidenceUrls: { type: 'array', maxItems: 10, items: { type: 'string', format: 'uri', maxLength: 2048 } },
            explanatoryText: { type: 'string', minLength: 10, maxLength: 5000 },
          },
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const { slug } = request.params as { slug: string };
      if (!deps.store.getDossier(slug)) {
        return reply.status(404).send(failure('NOT_FOUND', `Dossier not found: ${slug}`, request.requestId));
      }
      const ticket = deps.store.createCorrection(
        request.session!.userId,
        slug,
        request.body as { claimedIssue: string; evidenceUrls: string[]; explanatoryText: string },
      );
      return reply.status(201).send(success(ticket, { requestId: request.requestId }));
    },
  );

  fastify.get('/me/submissions', { preHandler: [requireAuth()] }, async (request, reply) => {
    noStore(reply);
    return success(deps.store.listMySubmissions(request.session!.userId), { requestId: request.requestId });
  });

  fastify.get('/me/orders', { preHandler: [requireAuth()] }, async (request, reply) => {
    noStore(reply);
    return success(deps.store.listMyOrders(request.session!.userId), { requestId: request.requestId, dataMode: dataModeOf(deps) });
  });
};
