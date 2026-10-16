/**
 * Queue registry (brief §8, ADR-0001).
 *
 * Queue messages hold IDs and schema versions — never whole private articles.
 * Every payload carries a deterministic `jobKey` so re-enqueueing the same
 * logical work is a no-op at the business layer even if the BullMQ job row
 * was removed.
 */

export const QUEUE_NAMES = [
  'discovery',
  'fetch',
  'extract',
  'draft',
  'review-preflight',
  'publish',
  'anchor-receipt',
  'recheck-receipt',
  'refresh-read-models',
  'render-share-card',
  'reconcile-payment',
  'reconcile-refund',
  'maintenance',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Every job payload carries the payload schema version + deterministic key. */
export interface JobEnvelope {
  schemaVersion: 1;
  jobKey: string;
  /** Correlates logs/traces across the pipeline for one logical run. */
  traceId?: string;
}

export interface DiscoveryJob extends JobEnvelope {
  runId: string;
}
export interface FetchJob extends JobEnvelope {
  runId: string;
  sourceId: string;
}
export interface ExtractJob extends JobEnvelope {
  runId: string;
  sourceSnapshotId: string;
}
export interface DraftJob extends JobEnvelope {
  runId: string;
  dossierDraftId: string;
}
export interface ReviewPreflightJob extends JobEnvelope {
  dossierDraftId: string;
  requestedBy: string;
}
export interface PublishJob extends JobEnvelope {
  subjectId: string;
  versionNumber: number;
  draftId: string;
}
export interface AnchorReceiptJob extends JobEnvelope {
  subjectId: string;
  versionNumber: number;
  payloadHash: string;
  /** On-chain publication kind label from the draft's canonical payload. */
  publicationKind: string;
}
export interface RecheckReceiptJob extends JobEnvelope {
  subjectId: string;
  versionNumber: number;
  /** Recheck round; each chained recheck bumps it so the deterministic job
   * key stays unique per round while remaining idempotent per round. */
  round: number;
}
export interface RefreshReadModelsJob extends JobEnvelope {
  scope: 'home' | 'collection' | 'stats' | 'all';
  sourceRevision: string;
}
export interface RenderShareCardJob extends JobEnvelope {
  subjectId: string;
  versionNumber: number;
}
export interface ReconcilePaymentJob extends JobEnvelope {
  orderId: string;
  intentId: string;
}
export interface ReconcileRefundJob extends JobEnvelope {
  refundId: string;
  orderId: string;
}
export interface MaintenanceJob extends JobEnvelope {
  task: 'prune-outbox' | 'prune-events' | 'clean-orphan-objects' | 'reconcile-stragglers';
}

export type QueuePayloads = {
  discovery: DiscoveryJob;
  fetch: FetchJob;
  extract: ExtractJob;
  draft: DraftJob;
  'review-preflight': ReviewPreflightJob;
  publish: PublishJob;
  'anchor-receipt': AnchorReceiptJob;
  'recheck-receipt': RecheckReceiptJob;
  'refresh-read-models': RefreshReadModelsJob;
  'render-share-card': RenderShareCardJob;
  'reconcile-payment': ReconcilePaymentJob;
  'reconcile-refund': ReconcileRefundJob;
  maintenance: MaintenanceJob;
};

/**
 * Deterministic job keys. Same logical work → same key → business dedup holds
 * even after the BullMQ job row is removed (removeOnComplete/removeOnFail).
 */
export const jobKeys = {
  discovery: (runId: string) => `discovery:${runId}`,
  fetch: (runId: string, sourceId: string) => `fetch:${runId}:${sourceId}`,
  extract: (runId: string, snapshotId: string) => `extract:${runId}:${snapshotId}`,
  draft: (runId: string, draftId: string) => `draft:${runId}:${draftId}`,
  reviewPreflight: (draftId: string) => `review-preflight:${draftId}`,
  publish: (subjectId: string, versionNumber: number) =>
    `publish:${subjectId}:v${versionNumber}`,
  anchorReceipt: (subjectId: string, versionNumber: number) =>
    `anchor-receipt:${subjectId}:v${versionNumber}`,
  recheckReceipt: (subjectId: string, versionNumber: number, round = 0) =>
    `recheck-receipt:${subjectId}:v${versionNumber}:r${round}`,
  refreshReadModels: (scope: RefreshReadModelsJob['scope'], sourceRevision: string) =>
    `refresh-read-models:${scope}:${sourceRevision}`,
  renderShareCard: (subjectId: string, versionNumber: number) =>
    `render-share-card:${subjectId}:v${versionNumber}`,
  reconcilePayment: (orderId: string, intentId: string) =>
    `reconcile-payment:${orderId}:${intentId}`,
  reconcileRefund: (refundId: string) => `reconcile-refund:${refundId}`,
  maintenance: (task: MaintenanceJob['task']) => `maintenance:${task}`,
  /** Outbox dispatch uses the event id so redispatch never double-enqueues. */
  outboxEvent: (eventId: string) => `outbox:${eventId}`,
};

/** Maps an outbox event type to the queue that consumes it. */
export const OUTBOX_EVENT_ROUTES: Record<string, QueueName> = {  'research.discovery.requested': 'discovery',
  'research.source.fetch.requested': 'fetch',
  'research.snapshot.extract.requested': 'extract',
  'research.draft.requested': 'draft',
  'editorial.review.preflight.requested': 'review-preflight',
  'editorial.version.publish.requested': 'publish',
  'receipt.anchor.requested': 'anchor-receipt',
  'receipt.recheck.requested': 'recheck-receipt',
  'readmodel.refresh.requested': 'refresh-read-models',
  'sharecard.render.requested': 'render-share-card',
  'payment.reconcile.requested': 'reconcile-payment',
  'refund.reconcile.requested': 'reconcile-refund',
};

/**
 * Public SSE event types (brief §14). These are not queue work — the outbox
 * dispatcher writes them to the `public_events` table (durable, replayable)
 * and marks the outbox event done. The API lane serves them over SSE.
 */
export const PUBLIC_EVENT_TYPES: ReadonlySet<string> = new Set([
  'dossier.published',
  'dossier.corrected',
  'dossier.retracted',
  'subject.status_changed',
  'research.started',
  'research.completed',
  'receipt.finalized',
  // Worker-internal lifecycle events surfaced to admins, not the public SSE:
  'payment.settled',
  'refund.settled',
]);
