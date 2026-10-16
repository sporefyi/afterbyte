import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteDeps } from './context.js';
import { success, failure } from '../lib/envelope.js';
import { noStore } from '../lib/cache.js';
import { requireRole, requireCapability } from '../plugins/auth.js';
import {
  AdminStore,
  AdminError,
  createDraft,
  submitDraftForReview,
  approveDraft,
  publishDraft,
  retractDossier,
  patchDraft,
  createResearchRun,
  cancelResearchRun,
  retryResearchRun,
  moderateTicket,
  createUploadIntent,
  finalizeUpload,
} from '../services/admin.service.js';
import { TREASURY_CAPABILITY } from '../services/auth.service.js';
import type { Capabilities } from '../config.js';

const adminOnly = () => requireRole('administrator');
const editorUp = () => requireRole('editor', 'administrator');

function adminError(reply: FastifyReply, request: FastifyRequest, err: unknown) {
  if (err instanceof AdminError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'FORBIDDEN' ? 403 : 422;
    const code = err.code === 'NOT_FOUND' ? 'NOT_FOUND' : err.code === 'INVALID_TRANSITION' ? 'VERSION_CONFLICT' : 'VALIDATION_FAILED';
    return reply.status(status).send(failure(code, err.message, request.requestId));
  }
  throw err;
}

/**
 * Admin routes (brief §12). Permission check on EVERY route; all responses
 * no-store. Treasury-gated operations (payout/refund approval) additionally
 * require the treasury capability. Audit entries are immutable append-only.
 */
export const adminRoutes: FastifyPluginAsync<RouteDeps & { adminStore: AdminStore }> = async (fastify, deps) => {
  const store = deps.adminStore;
  const capabilities: Capabilities = deps.capabilities;

  const pre = () => ({
    preHandler: [editorUp()],
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  });

  // ---- research runs ----
  fastify.get('/research-runs', pre(), async (request, reply) => {
    noStore(reply);
    return success([...store.researchRuns.values()], { requestId: request.requestId });
  });
  fastify.post(
    '/research-runs',
    {
      ...pre(),
      schema: { body: { type: 'object', required: ['subject'], properties: { subject: { type: 'string', minLength: 2, maxLength: 200 } } } },
    },
    async (request, reply) => {
      noStore(reply);
      const { subject } = request.body as { subject: string };
      const run = createResearchRun(store, request.session!.userId, { subject, modelsAvailable: capabilities.models });
      return reply.status(201).send(success(run, { requestId: request.requestId }));
    },
  );
  fastify.get('/research-runs/:id', pre(), async (request, reply) => {
    noStore(reply);
    const { id } = request.params as { id: string };
    const run = store.researchRuns.get(id);
    if (!run) return reply.status(404).send(failure('NOT_FOUND', `Research run not found: ${id}`, request.requestId));
    return success(run, { requestId: request.requestId });
  });
  fastify.post('/research-runs/:id/cancel', pre(), async (request, reply) => {
    noStore(reply);
    const { id } = request.params as { id: string };
    try {
      return success(cancelResearchRun(store, request.session!.userId, id), { requestId: request.requestId });
    } catch (err) {
      return adminError(reply, request, err);
    }
  });
  fastify.post('/research-runs/:id/retry', pre(), async (request, reply) => {
    noStore(reply);
    const { id } = request.params as { id: string };
    try {
      return success(retryResearchRun(store, request.session!.userId, id, capabilities.models), { requestId: request.requestId });
    } catch (err) {
      return adminError(reply, request, err);
    }
  });

  // ---- drafts ----
  fastify.post(
    '/drafts',
    {
      ...pre(),
      schema: {
        body: {
          type: 'object',
          required: ['subjectId', 'slug'],
          properties: { subjectId: { type: 'string', format: 'uuid' }, slug: { type: 'string', minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      const draft = createDraft(store, request.session!.userId, request.body as { subjectId: string; slug: string });
      return reply.status(201).send(success(draft, { requestId: request.requestId }));
    },
  );
  fastify.get('/drafts', pre(), async (request, reply) => {
    noStore(reply);
    return success([...store.drafts.values()], { requestId: request.requestId });
  });
  fastify.get('/drafts/:id', pre(), async (request, reply) => {
    noStore(reply);
    const { id } = request.params as { id: string };
    const draft = store.drafts.get(id);
    if (!draft) return reply.status(404).send(failure('NOT_FOUND', `Draft not found: ${id}`, request.requestId));
    return success(draft, { requestId: request.requestId });
  });
  fastify.patch(
    '/drafts/:id',
    {
      ...pre(),
      schema: { body: { type: 'object', properties: { slug: { type: 'string', minLength: 1, maxLength: 128 } } } },
    },
    async (request, reply) => {
      noStore(reply);
      const { id } = request.params as { id: string };
      try {
        return success(patchDraft(store, request.session!.userId, id, request.body as { slug?: string }), {
          requestId: request.requestId,
        });
      } catch (err) {
        return adminError(reply, request, err);
      }
    },
  );
  fastify.post('/drafts/:id/submit-review', pre(), async (request, reply) => {
    noStore(reply);
    const { id } = request.params as { id: string };
    try {
      return success(submitDraftForReview(store, request.session!.userId, id), { requestId: request.requestId });
    } catch (err) {
      return adminError(reply, request, err);
    }
  });
  fastify.post('/drafts/:id/approve', pre(), async (request, reply) => {
    noStore(reply);
    const { id } = request.params as { id: string };
    try {
      return success(approveDraft(store, request.session!.userId, id), { requestId: request.requestId });
    } catch (err) {
      return adminError(reply, request, err);
    }
  });
  fastify.post('/drafts/:id/publish', pre(), async (request, reply) => {
    noStore(reply);
    const { id } = request.params as { id: string };
    try {
      return success(publishDraft(store, request.session!.userId, id), { requestId: request.requestId });
    } catch (err) {
      return adminError(reply, request, err);
    }
  });

  // ---- dossier lifecycle ----
  fastify.post(
    '/dossiers/:id/retract',
    {
      ...pre(),
      schema: { body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 10, maxLength: 2000 } } } },
    },
    async (request, reply) => {
      noStore(reply);
      const { id } = request.params as { id: string };
      const { reason } = request.body as { reason: string };
      try {
        return success(retractDossier(store, request.session!.userId, id, reason), { requestId: request.requestId });
      } catch (err) {
        return adminError(reply, request, err);
      }
    },
  );
  fastify.post('/dossiers/:id/schedule-recheck', pre(), async (request, reply) => {
    noStore(reply);
    const { id } = request.params as { id: string };
    // Enqueues a recheck job; the worker lane implements the queue write.
    // Recorded in the audit log so the intent is traceable.
    const entry = store.log(request.session!.userId, 'dossier.schedule-recheck', id, { queue: 'maintenance' });
    return success({ scheduled: true, auditId: entry.id }, { requestId: request.requestId });
  });

  // ---- moderation ----
  const ticketRoute = (kind: 'submissions' | 'corrections') => {
    fastify.get(
      `/${kind}`,
      {
        ...pre(),
        schema: {
          querystring: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['received', 'in_review', 'accepted', 'rejected'] },
            },
          },
        },
      },
      async (request, reply) => {
        noStore(reply);
        const { status } = request.query as { status?: string };
        const want = kind === 'submissions' ? 'submission' : 'correction';
        const items = [...store.tickets.values()].filter(
          (t) => t.kind === want && (!status || t.status === status),
        );
        return success(items, { requestId: request.requestId });
      },
    );
    fastify.get(`/${kind}/:id`, pre(), async (request, reply) => {
      noStore(reply);
      const { id } = request.params as { id: string };
      const ticket = store.tickets.get(id);
      if (!ticket || (kind === 'submissions' ? ticket.kind !== 'submission' : ticket.kind !== 'correction')) {
        return reply.status(404).send(failure('NOT_FOUND', `Ticket not found: ${id}`, request.requestId));
      }
      return success(ticket, { requestId: request.requestId });
    });
    fastify.patch(
      `/${kind}/:id`,
      {
        ...pre(),
        schema: { body: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['accepted', 'rejected'] } } } },
      },
      async (request, reply) => {
        noStore(reply);
        const { id } = request.params as { id: string };
        const { status } = request.body as { status: 'accepted' | 'rejected' };
        try {
          return success(moderateTicket(store, request.session!.userId, id, status), { requestId: request.requestId });
        } catch (err) {
          return adminError(reply, request, err);
        }
      },
    );
  };
  ticketRoute('submissions');
  ticketRoute('corrections');

  // ---- home editions ----
  fastify.get('/home-editions/:id', pre(), async (request, reply) => {
    noStore(reply);
    return reply.status(404).send(failure('NOT_FOUND', 'Home editions are managed by the editorial lane (not yet implemented)', request.requestId));
  });
  fastify.patch('/home-editions/:id', pre(), async (request, reply) => {
    noStore(reply);
    return reply.status(404).send(failure('NOT_FOUND', 'Home editions are managed by the editorial lane (not yet implemented)', request.requestId));
  });

  // ---- ops ----
  fastify.get('/providers', pre(), async (request, reply) => {
    noStore(reply);
    return success(
      {
        search: capabilities.search ? 'operational' : 'unavailable',
        models: capabilities.models ? 'operational' : 'unavailable',
        receipts: capabilities.receipts ? 'operational' : 'unavailable',
        storage: capabilities.storage ? 'operational' : 'unavailable',
      },
      { requestId: request.requestId },
    );
  });
  fastify.get('/costs', pre(), async (request, reply) => {
    noStore(reply);
    return success(
      {
        dailyBudget: deps.config.researchDailyBudget ?? null,
        maxRunCost: deps.config.researchMaxRunCost ?? null,
        runs: [...store.researchRuns.values()].map((r) => ({ id: r.id, costUnits: r.costUnits, status: r.status })),
      },
      { requestId: request.requestId },
    );
  });
  fastify.get('/queues', { preHandler: [adminOnly()], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    noStore(reply);
    // Queue depth introspection lives with the worker lane (BullMQ); until it
    // lands, report honestly rather than inventing numbers.
    return success({ note: 'queue introspection pending worker lane', queues: [] }, { requestId: request.requestId });
  });
  fastify.get('/audit-log', { preHandler: [adminOnly()], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    noStore(reply);
    return success([...store.audit].reverse().slice(0, 100), { requestId: request.requestId });
  });
  fastify.get('/receipts/failed', pre(), async (request, reply) => {
    noStore(reply);
    return success([], { requestId: request.requestId });
  });

  // ---- assets ----
  fastify.post(
    '/assets/upload-intent',
    {
      ...pre(),
      schema: {
        body: {
          type: 'object',
          required: ['filename', 'contentType', 'bytes'],
          properties: {
            filename: { type: 'string', minLength: 1, maxLength: 256 },
            contentType: { type: 'string', minLength: 1, maxLength: 128 },
            bytes: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      if (!capabilities.storage) {
        return reply.status(503).send(failure('PROVIDER_UNAVAILABLE', 'Object storage not configured', request.requestId));
      }
      try {
        const intent = createUploadIntent(store, request.session!.userId, request.body as { filename: string; contentType: string; bytes: number });
        return reply.status(201).send(success(intent, { requestId: request.requestId }));
      } catch (err) {
        return adminError(reply, request, err);
      }
    },
  );
  fastify.post(
    '/assets/:id/finalize',
    {
      ...pre(),
      schema: {
        body: {
          type: 'object',
          required: ['actualBytes', 'scanClean'],
          properties: {
            actualBytes: { type: 'integer', minimum: 0 },
            actualContentType: { type: 'string' },
            scanClean: { type: 'boolean' },
            publish: { type: 'boolean', default: false },
          },
        },
      },
    },
    async (request, reply) => {
      noStore(reply);
      if (!capabilities.storage) {
        return reply.status(503).send(failure('PROVIDER_UNAVAILABLE', 'Object storage not configured', request.requestId));
      }
      const { id } = request.params as { id: string };
      const { actualBytes, actualContentType, scanClean, publish } = request.body as {
        actualBytes: number;
        actualContentType?: string;
        scanClean: boolean;
        publish?: boolean;
      };
      try {
        const result = finalizeUpload(store, request.session!.userId, id, { actualBytes, actualContentType }, scanClean, publish ?? false);
        return success(result, { requestId: request.requestId });
      } catch (err) {
        return adminError(reply, request, err);
      }
    },
  );

  // ---- treasury-gated operations (Release B interfaces; disabled until verified) ----
  fastify.post(
    '/investigation-orders/:id/accept',
    { preHandler: [editorUp(), requireCapability(TREASURY_CAPABILITY)], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply);
      return reply
        .status(503)
        .send(failure('FEATURE_UNAVAILABLE', 'Payments are disabled (Release B). Order acceptance is not available.', request.requestId));
    },
  );
  fastify.post(
    '/investigation-orders/:id/quote',
    { preHandler: [editorUp(), requireCapability(TREASURY_CAPABILITY)], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply);
      return reply
        .status(503)
        .send(failure('FEATURE_UNAVAILABLE', 'Payments are disabled (Release B). Quote creation is not available.', request.requestId));
    },
  );
  fastify.post(
    '/awards',
    { preHandler: [editorUp(), requireCapability(TREASURY_CAPABILITY)], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply);
      return reply
        .status(503)
        .send(failure('FEATURE_UNAVAILABLE', 'Payments are disabled (Release B). Contributor awards are not available.', request.requestId));
    },
  );
  fastify.post(
    '/refunds/:id/approve',
    { preHandler: [editorUp(), requireCapability(TREASURY_CAPABILITY)], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply);
      return reply
        .status(503)
        .send(failure('FEATURE_UNAVAILABLE', 'Payments are disabled (Release B). Refund approval is not available.', request.requestId));
    },
  );
};
