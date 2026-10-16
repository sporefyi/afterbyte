/**
 * Admin business rules (brief §12 admin endpoints). State machines live here
 * as pure, importable functions — handlers and the worker lane call the same
 * transitions, so authorization and state rules cannot drift between HTTP and
 * queue processing.
 */
import { randomUUID } from 'node:crypto';
import { buildQuarantineKey, validateIntentRequest, validateFinalize, publicKeyFor } from '@afterbyte/storage';

export type DraftStatus = 'draft' | 'in_review' | 'approved' | 'published' | 'retracted';

export interface Draft {
  id: string;
  subjectId: string;
  slug: string;
  status: DraftStatus;
  version: number;
  updatedAt: string;
  history: { at: string; by: string; from: DraftStatus; to: DraftStatus; note?: string }[];
}

export type ResearchRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'awaiting_provider';

export interface ResearchRun {
  id: string;
  subject: string;
  status: ResearchRunStatus;
  createdAt: string;
  costUnits: string; // integer-as-string, never float money
}

export type TicketStatus = 'open' | 'accepted' | 'rejected';

export interface ModerationTicket {
  id: string;
  kind: 'submission' | 'correction';
  status: TicketStatus;
  decidedBy?: string;
  decidedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
}

export interface UploadIntent {
  id: string;
  quarantineKey: string;
  filename: string;
  contentType: string;
  bytes: number;
  status: 'pending' | 'finalized' | 'rejected';
  createdAt: string;
}

const DRAFT_TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  draft: ['in_review'],
  in_review: ['approved', 'draft'],
  approved: ['published', 'draft'],
  published: ['retracted'],
  retracted: [],
};

export class AdminError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_TRANSITION' | 'FORBIDDEN' | 'VALIDATION_FAILED',
    message: string,
  ) {
    super(message);
  }
}

/** In-memory admin state. The database lane persists these records. */
export class AdminStore {
  drafts = new Map<string, Draft>();
  researchRuns = new Map<string, ResearchRun>();
  tickets = new Map<string, ModerationTicket>();
  audit: AuditEntry[] = [];
  intents = new Map<string, UploadIntent>();

  log(actor: string, action: string, target: string, detail: Record<string, unknown> = {}): AuditEntry {
    const entry: AuditEntry = { id: randomUUID(), at: new Date().toISOString(), actor, action, target, detail };
    this.audit.push(entry);
    return entry;
  }
}

function transitionDraft(store: AdminStore, actor: string, id: string, to: DraftStatus, note?: string): Draft {
  const draft = store.drafts.get(id);
  if (!draft) throw new AdminError('NOT_FOUND', `Draft not found: ${id}`);
  if (!DRAFT_TRANSITIONS[draft.status].includes(to)) {
    throw new AdminError('INVALID_TRANSITION', `Cannot transition draft ${id} from ${draft.status} to ${to}`);
  }
  const from = draft.status;
  draft.status = to;
  draft.updatedAt = new Date().toISOString();
  draft.history.push({ at: draft.updatedAt, by: actor, from, to, note });
  store.log(actor, `draft.${to}`, id, { from, note });
  return draft;
}

export function createDraft(store: AdminStore, actor: string, input: { subjectId: string; slug: string }): Draft {
  const draft: Draft = {
    id: randomUUID(),
    subjectId: input.subjectId,
    slug: input.slug,
    status: 'draft',
    version: 1,
    updatedAt: new Date().toISOString(),
    history: [],
  };
  store.drafts.set(draft.id, draft);
  store.log(actor, 'draft.create', draft.id, { slug: input.slug });
  return draft;
}

export function submitDraftForReview(store: AdminStore, actor: string, id: string): Draft {
  return transitionDraft(store, actor, id, 'in_review');
}

export function approveDraft(store: AdminStore, actor: string, id: string): Draft {
  return transitionDraft(store, actor, id, 'approved');
}

/**
 * Publish: the DB commit of the immutable version + current-version pointer
 * + receipt outbox job is one transaction (ADR-0002). Here we record the
 * transition and audit entry; the database lane implements the transaction.
 */
export function publishDraft(store: AdminStore, actor: string, id: string): Draft {
  return transitionDraft(store, actor, id, 'published', 'immutable version committed; receipt outbox enqueued');
}

export function retractDossier(store: AdminStore, actor: string, dossierId: string, reason: string): Draft {
  const draft = [...store.drafts.values()].find((d) => d.subjectId === dossierId && d.status === 'published');
  if (!draft) throw new AdminError('NOT_FOUND', `No published draft for dossier: ${dossierId}`);
  return transitionDraft(store, actor, draft.id, 'retracted', reason);
}

export function patchDraft(store: AdminStore, actor: string, id: string, patch: { slug?: string }): Draft {
  const draft = store.drafts.get(id);
  if (!draft) throw new AdminError('NOT_FOUND', `Draft not found: ${id}`);
  if (draft.status !== 'draft') throw new AdminError('INVALID_TRANSITION', 'Only draft-status records can be patched');
  if (patch.slug) draft.slug = patch.slug;
  draft.updatedAt = new Date().toISOString();
  store.log(actor, 'draft.patch', id, { patch });
  return draft;
}

export function createResearchRun(store: AdminStore, actor: string, input: { subject: string; modelsAvailable: boolean }): ResearchRun {
  const run: ResearchRun = {
    id: randomUUID(),
    subject: input.subject,
    status: input.modelsAvailable ? 'queued' : 'awaiting_provider',
    createdAt: new Date().toISOString(),
    costUnits: '0',
  };
  store.researchRuns.set(run.id, run);
  store.log(actor, 'research-run.create', run.id, { subject: input.subject });
  return run;
}

export function cancelResearchRun(store: AdminStore, actor: string, id: string): ResearchRun {
  const run = store.researchRuns.get(id);
  if (!run) throw new AdminError('NOT_FOUND', `Research run not found: ${id}`);
  if (run.status === 'completed' || run.status === 'failed') {
    throw new AdminError('INVALID_TRANSITION', `Cannot cancel a ${run.status} run`);
  }
  run.status = 'cancelled';
  store.log(actor, 'research-run.cancel', id, {});
  return run;
}

export function retryResearchRun(store: AdminStore, actor: string, id: string, modelsAvailable: boolean): ResearchRun {
  const run = store.researchRuns.get(id);
  if (!run) throw new AdminError('NOT_FOUND', `Research run not found: ${id}`);
  if (run.status !== 'failed' && run.status !== 'cancelled') {
    throw new AdminError('INVALID_TRANSITION', `Cannot retry a ${run.status} run`);
  }
  run.status = modelsAvailable ? 'queued' : 'awaiting_provider';
  store.log(actor, 'research-run.retry', id, {});
  return run;
}

export function moderateTicket(
  store: AdminStore,
  actor: string,
  id: string,
  status: TicketStatus,
): ModerationTicket {
  const ticket = store.tickets.get(id);
  if (!ticket) throw new AdminError('NOT_FOUND', `Ticket not found: ${id}`);
  if (ticket.status !== 'open') throw new AdminError('INVALID_TRANSITION', `Ticket ${id} already ${ticket.status}`);
  ticket.status = status;
  ticket.decidedBy = actor;
  ticket.decidedAt = new Date().toISOString();
  store.log(actor, `ticket.${status}`, id, { kind: ticket.kind });
  return ticket;
}

export function createUploadIntent(
  store: AdminStore,
  actor: string,
  input: { filename: string; contentType: string; bytes: number; maxBytes?: number },
): UploadIntent {
  const valid = validateIntentRequest(input);
  if (!valid.ok) throw new AdminError('VALIDATION_FAILED', `Upload intent rejected: ${valid.reason}`);
  const id = randomUUID();
  const intent: UploadIntent = {
    id,
    quarantineKey: buildQuarantineKey(id, input.filename),
    filename: input.filename,
    contentType: input.contentType,
    bytes: input.bytes,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  store.intents.set(id, intent);
  store.log(actor, 'asset.upload-intent', id, { quarantineKey: intent.quarantineKey });
  return intent;
}

export interface FinalizeResult {
  intent: UploadIntent;
  publicKey: string | null;
}

/**
 * Finalize an upload after the client PUT the bytes to the quarantine key.
 * `observed` comes from a HEAD on the quarantine object; `scanClean` from
 * the worker's async safety scan. Pure business rule — storage I/O stays in
 * the route/worker.
 */
export function finalizeUpload(
  store: AdminStore,
  actor: string,
  id: string,
  observed: { actualBytes: number; actualContentType?: string },
  scanClean: boolean,
  publish: boolean,
): FinalizeResult {
  const intent = store.intents.get(id);
  if (!intent) throw new AdminError('NOT_FOUND', `Upload intent not found: ${id}`);
  if (intent.status !== 'pending') throw new AdminError('INVALID_TRANSITION', `Intent ${id} already ${intent.status}`);
  const check = validateFinalize({
    intentId: id,
    quarantineKey: intent.quarantineKey,
    declaredContentType: intent.contentType,
    declaredBytes: intent.bytes,
    actualBytes: observed.actualBytes,
    actualContentType: observed.actualContentType,
    publish,
  });
  if (!check.ok || !scanClean) {
    intent.status = 'rejected';
    store.log(actor, 'asset.finalize.rejected', id, { reason: check.ok ? 'scan_failed' : check.reason });
    throw new AdminError('VALIDATION_FAILED', `Finalize rejected: ${check.ok ? 'scan_failed' : check.reason}`);
  }
  intent.status = 'finalized';
  const publicKey = publish ? publicKeyFor(intent.quarantineKey) : null;
  store.log(actor, 'asset.finalize', id, { publicKey });
  return { intent, publicKey };
}
